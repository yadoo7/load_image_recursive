"""Load Image (Recursive) — 原生「加载图片」的递归版，外加目录过滤与缩略图修复。

三件事：

1. **递归扫描** input 目录，把各级子目录里的图片一并列进下拉，
   路径用相对 input 的正斜杠形式（例如 "老电脑/胶片/xxx.jpg"）。
2. **目录过滤**：前面那个 `folder` widget 只是前端过滤器，选中某个目录后
   把下面的 `image` 列表收窄成该目录下的文件，避免在 1200+ 项里翻找。
   它不参与出图，`load_image()` 收下就扔，`IS_CHANGED` 也不看它。
3. **缩略图修复**（见下方「为什么要挂 middleware」）。

解码、上传按钮、拖拽、粘贴、遮罩输出、路径安全校验，全部继承原生 LoadImage，
所以行为跟原生节点完全一致，只是下拉列表多了子目录里的图。

名为 clipspace 的目录会被跳过（那是 MaskEditor 生成的临时文件，
出现在列表里只会是噪音）。

---

为什么要挂 middleware
=====================

ComfyUI 前端的 combo 缩略图 URL 由打包产物里的 `getMediaUrl(filename, type, kind)`
生成，它只拼 `filename` + `type`，**不带 `subfolder`，也不带 `preview` / `max`**。
于是我们这个节点会遇到两个上游问题：

* 子目录图片 → `/api/view?filename=美女/0.jpg&type=input`
  → 服务端拿 basename 去 input 根目录找 → **404，下拉里没有缩略图**
* 根目录大图 → 同一个 URL，服务端**把 38MB / 52MP 原图整张发下来**
  → 下拉一打开就卡住

`/view` 其实**原生就支持 `subfolder=` 参数**（带目录逃逸校验），
所以第一个问题只要把路径拆开就行；第二个问题需要一个 `max` 降采样，
而原生没有。

两条路：改 ComfyUI 的 `server.py`（改核心，用户升级就冲突），
或者在节点里挂一个 aiohttp middleware 把这两件事在**请求进入 handler 之前**做掉。
这里选后者 —— 零核心改动，`git clone` 就能用。

判据
----

middleware 只对「`filename` 里带 `/`」的请求动手，因为原生 LoadImage 的候选值
永远不带斜杠，所以带斜杠一定是子目录感知的调用方（我们这个节点，或同类节点）。
再分两种情况：

* 带 `channel` / `preview` / `max` → 画布预览、MaskEditor、或已经打过前端补丁的
  请求，意图明确 → 只补上 `subfolder`，剩下交给原生 handler
* 都不带（裸请求）→ 是 combo 下拉在要缩略图 → 自己降采样成 webp 返回

挂了 middleware 也不影响原生行为：判据不命中的请求原样放行。
"""

import asyncio
import hashlib
import logging
import os
import posixpath
import threading
from collections import OrderedDict
from io import BytesIO

import folder_paths
from nodes import LoadImage

try:
    from aiohttp import web
except Exception:  # pragma: no cover - aiohttp 是 ComfyUI 的硬依赖，理论上不会走到
    web = None

SKIP_DIR_NAMES = {"clipspace"}
ALL_FOLDERS = "(全部)"

# 下拉缩略图的参数。384 够 100px 的格子在高分屏上清晰，又不至于让列表变重。
THUMB_LIMIT = 384
THUMB_FORMAT = "webp"
THUMB_QUALITY = 80
THUMB_CACHE_MAX = 2048


# ---------------------------------------------------------------------------
# 文件 / 目录扫描
# ---------------------------------------------------------------------------

def _collect_files(input_dir):
    """递归列出 input 下所有图片，返回相对 input 的正斜杠路径（已排序）。"""
    files = []
    if not os.path.isdir(input_dir):
        return files
    for root, dirs, fnames in os.walk(input_dir):
        # 剪枝：跳过 clipspace 一类的临时目录
        dirs[:] = [d for d in dirs if d not in SKIP_DIR_NAMES]
        rel_root = os.path.relpath(root, input_dir)
        for fname in fnames:
            rel = fname if rel_root == "." else os.path.join(rel_root, fname)
            files.append(rel.replace("\\", "/"))
    # 跟原生一样按 MIME 过滤，只留真正的图片
    files = folder_paths.filter_files_content_types(files, ["image"])
    return sorted(files)


def _collect_folders(files):
    """从文件路径里提取所有层级的祖先目录，例如 老电脑/胶片/x.jpg -> 老电脑, 老电脑/胶片。"""
    found = set()
    for f in files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            found.add("/".join(parts[:i]))
    return sorted(found)


# ---------------------------------------------------------------------------
# 缩略图
# ---------------------------------------------------------------------------

# LRU。渲染跑在线程池里，所以访问要加锁。
_THUMB_CACHE = OrderedDict()
_THUMB_LOCK = threading.Lock()


def _thumb_cache_key(path, limit):
    """缓存键带上 mtime + size，文件被替换或编辑过就自动失效。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (path, st.st_mtime_ns, st.st_size, limit)


def render_thumbnail(path, limit=THUMB_LIMIT):
    """把图片降采样成缩略图字节，带进程内 LRU 缓存。

    故意不做 EXIF 旋转 —— 原生 /view 的预览分支也不做，保持一致，
    免得同一个下拉里根目录的图和子目录的图朝向不一样。
    """
    from PIL import Image

    key = _thumb_cache_key(path, limit)
    if key is not None:
        with _THUMB_LOCK:
            cached = _THUMB_CACHE.get(key)
            if cached is not None:
                _THUMB_CACHE.move_to_end(key)
                return cached

    with Image.open(path) as img:
        if limit > 0 and max(img.size) > limit:
            try:
                # JPEG 专用：让 libjpeg 直接按 1/2、1/4、1/8 的 DCT 尺度解码，
                # 而不是先把 52MP 全解出来再重采样。其它格式上是 no-op。
                img.draft("RGB", (limit, limit))
                img.thumbnail((limit, limit), Image.LANCZOS)
            except Exception:
                # I;16 / F 一类的模式不一定能重采样，退化成原尺寸重编码
                pass
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        buffer = BytesIO()
        img.save(buffer, format=THUMB_FORMAT, quality=THUMB_QUALITY)
        body = buffer.getvalue()

    if key is not None:
        with _THUMB_LOCK:
            _THUMB_CACHE[key] = body
            _THUMB_CACHE.move_to_end(key)
            # 淘汰最旧的，而不是像以前那样整表清空 —— 清空会让紧接着的
            # 那次下拉把刚编码过的几十张图全部重算一遍
            while len(_THUMB_CACHE) > THUMB_CACHE_MAX:
                _THUMB_CACHE.popitem(last=False)
    return body


def _resolve_in_type_dir(filename, type_name):
    """把「相对路径 + type」解析成绝对路径，越界返回 None。"""
    base = folder_paths.get_directory_by_type(type_name or "output")
    if not base:
        return None
    base = os.path.abspath(base)
    target = os.path.abspath(os.path.join(base, filename))
    try:
        if os.path.commonpath((target, base)) != base:
            return None
    except ValueError:
        return None
    return target


async def _serve_thumbnail(request, filename, type_name, limit=THUMB_LIMIT):
    path = _resolve_in_type_dir(filename, type_name)
    if path is None:
        return web.Response(status=403)
    if not os.path.isfile(path):
        return web.Response(status=404)
    try:
        # 解码 + 重编码是纯 CPU 活，一张 52MP 的图能占住几百毫秒。
        # 直接 await 会卡住事件循环，整个 UI 跟着僵；扔线程池里。
        body = await asyncio.get_running_loop().run_in_executor(
            None, render_thumbnail, path, limit
        )
    except Exception:
        # 打不开 / 不是图片 → 让前端显示占位图，跟原生 404 的表现一致
        return web.Response(status=404)
    return web.Response(
        body=body,
        content_type="image/%s" % THUMB_FORMAT,
        headers={"Cache-Control": "public, max-age=3600"},
    )


def _with_subfolder(request, filename, query):
    """把 `filename=美女/0.jpg` 拆成 `filename=0.jpg&subfolder=美女`。

    原生 /view 本来就有 subfolder 参数（带目录逃逸校验），
    只是前端的 combo URL 生成器忘了带，这里替它补上。
    """
    sub, base = posixpath.split(filename.replace("\\", "/"))
    params = dict(query)
    params["filename"] = base
    params["subfolder"] = sub
    return request.clone(rel_url=request.rel_url.with_query(params))


if web is not None:

    @web.middleware
    async def _subfolder_view_middleware(request, handler):
        if request.method != "GET" or request.path not in ("/view", "/api/view"):
            return await handler(request)

        query = request.rel_url.query
        filename = query.get("filename", "")
        type_name = query.get("type", "output")
        has_slash = "/" in filename or "\\" in filename

        # 原生 /view 还认两种我们不复刻的形态，一律放行让它自己处理：
        #   - annotated 后缀（`xxx[input]` / `xxx[output]` / `xxx[temp]`）
        #   - asset hash（filename 是内容哈希，由 asset manager 解析）
        # 两者都不带斜杠，本来也走不到下面，这里只是把边界写死。
        if filename.endswith(("[input]", "[output]", "[temp]")):
            return await handler(request)
        if type_name not in ("input", "output", "temp"):
            # 原生对未知 type 回 400，我们不该抢着回 403
            return await handler(request)

        def delegate():
            """交给原生 handler；带斜杠的先拆成 subfolder + basename。"""
            if has_slash:
                return handler(_with_subfolder(request, filename, query))
            return handler(request)

        # ① MaskEditor：channel 是它独有的，必须走原生 handler 拿真实像素
        if "channel" in query:
            return await delegate()

        # ② 显式要了 max（打过前端补丁的下拉）→ 按它要的尺寸降采样。
        #    原生 handler 不认 max，所以这里自己处理，省掉改 server.py。
        max_side = query.get("max", "")
        if max_side.isdigit():
            return await _serve_thumbnail(
                request, filename, type_name, limit=int(max_side)
            )

        # ③ 带 preview 但没 max：画布、图片查看器之类，意图明确 → 补 subfolder 放行
        if "preview" in query:
            return await delegate()

        # ④ 裸请求 + 带斜杠 = combo 下拉在要缩略图。
        #    原生实现会把 basename 拿去 input 根目录找 → 必然 404，
        #    所以这里接管是纯增益，不可能比原来更差。
        if has_slash:
            return await _serve_thumbnail(request, filename, type_name)

        # ⑤ 其余（含根目录图片的裸请求）一律不碰，保持 ComfyUI 原生行为
        return await handler(request)

    # 热重载会把模块重新执行一遍，函数对象跟着换新的 —— 靠身份判断会重复挂载，
    # 所以打一个稳定标记，install 时按标记去重。
    _subfolder_view_middleware._load_image_recursive_middleware = True


def _install_view_middleware():
    """把 middleware 挂到 ComfyUI 的 aiohttp app 上。

    必须在 app 冻结（启动）之前 append —— custom node 是在 main.py 里
    实例化 PromptServer 之后、app.run() 之前导入的，正好赶得上。

    挂不上也不影响节点本身，只是缩略图退回 ComfyUI 的原生行为
    （子目录图片没有缩略图）。
    """
    if web is None:
        return False
    try:
        from server import PromptServer
    except Exception as exc:
        logging.warning("[LoadImageRecursive] 拿不到 PromptServer，缩略图 middleware 未挂载: %s", exc)
        return False

    app = getattr(getattr(PromptServer, "instance", None), "app", None)
    if app is None:
        logging.warning("[LoadImageRecursive] PromptServer.instance 还没建好，缩略图 middleware 未挂载")
        return False

    middlewares = getattr(app, "middlewares", None)
    if middlewares is None or getattr(middlewares, "frozen", True):
        # frozen 说明 app 已经在跑了，这时候再挂没用
        logging.warning("[LoadImageRecursive] aiohttp app 已冻结，缩略图 middleware 未挂载")
        return False
    # 按标记去重：热重载后函数对象是新的，但标记还在，不会挂第二份
    if any(getattr(m, "_load_image_recursive_middleware", False) for m in middlewares):
        return True
    try:
        middlewares.append(_subfolder_view_middleware)
    except Exception as exc:
        logging.warning("[LoadImageRecursive] 挂载缩略图 middleware 失败: %s", exc)
        return False
    logging.info(
        "[LoadImageRecursive] 子目录缩略图 middleware 已挂载（最长边 %dpx，%s q%d）",
        THUMB_LIMIT, THUMB_FORMAT, THUMB_QUALITY,
    )
    return True


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------

class LoadImageRecursive(LoadImage):
    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = _collect_files(input_dir)
        folders = [ALL_FOLDERS] + _collect_folders(files)
        return {
            "required": {
                "folder": (folders, {
                    "tooltip": "只用来过滤下面的图片列表，不参与出图。选了目录后图片下拉只列该目录下的文件。",
                }),
                "image": (files, {"image_upload": True}),
            },
        }

    CATEGORY = "image"
    # 让中英文关键词都能搜到（原生 LoadImage 的别名一并继承）
    SEARCH_ALIASES = [
        "load image", "open image", "import image", "image input",
        "upload image", "read image", "image loader",
        "recursive", "recursive load image", "subfolder", "subdirectory",
        "load image recursive", "load image subfolder", "folder filter",
        "子目录", "含子目录", "递归", "递归加载图片", "加载图片 子目录",
        "目录", "文件夹", "目录过滤",
    ]
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "filename")
    FUNCTION = "load_image"

    def load_image(self, folder, image):
        # folder 只是前端过滤器，这里收下就扔
        # 解码、EXIF 旋转、alpha→mask 全部走原生实现
        image_tensor, mask_tensor = super().load_image(image)
        return (image_tensor, mask_tensor, image)

    @classmethod
    def IS_CHANGED(s, folder, image):
        # 与原生一致；folder 不参与缓存判定，切目录不会触发重跑
        image_path = folder_paths.get_annotated_filepath(image)
        m = hashlib.sha256()
        with open(image_path, "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, folder, image):
        # 显式列出 folder，免得 ComfyUI 拿它去比对 combo 候选列表
        # （execution.py 里，参数进了 VALIDATE_INPUTS 签名就跳过 value_not_in_list 检查）
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {"LoadImageRecursive": LoadImageRecursive}
NODE_DISPLAY_NAME_MAPPINGS = {"LoadImageRecursive": "加载图片(含子目录)"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_install_view_middleware()
