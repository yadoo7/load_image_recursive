"""load_image_recursive 的单元测试。

两种跑法都能过：

* **在 ComfyUI 里跑**（`<ComfyUI>/python_embeded/python.exe -m unittest discover tests`）
  → 用真实的 `folder_paths` / `nodes`
* **裸环境跑**（CI 里 `python -m unittest discover tests`）
  → 检测不到 ComfyUI 就装一套最小 stub，只需要 `aiohttp` + `Pillow`

重点是 middleware 的分流表 —— 那是整个「零核心改动」方案的命门，
判据错一条就可能把原生能正常工作的请求弄坏。
"""
import asyncio
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_DIR = os.path.dirname(HERE)
NODE_FILE = os.path.join(NODE_DIR, "__init__.py")

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif")


# ---------------------------------------------------------------------------
# 环境准备
# ---------------------------------------------------------------------------

def _maybe_add_comfyui_to_path():
    """装在 ComfyUI 里的话，把 ComfyUI 根目录加进 sys.path，好用真模块。"""
    directory = NODE_DIR
    for _ in range(5):
        directory = os.path.dirname(directory)
        if not directory or directory == os.path.dirname(directory):
            break
        if os.path.isfile(os.path.join(directory, "main.py")) and os.path.isdir(
            os.path.join(directory, "comfy")
        ):
            if directory not in sys.path:
                sys.path.insert(0, directory)
            return directory
    return None


COMFYUI_ROOT = _maybe_add_comfyui_to_path()


def _install_comfy_stubs():
    """没有 ComfyUI 就装最小替身，让节点模块能被 import。"""
    need_fp = need_nodes = False
    try:
        import folder_paths  # noqa: F401
    except Exception:
        need_fp = True
    try:
        import nodes  # noqa: F401
    except Exception:
        need_nodes = True

    if need_fp:
        fp = types.ModuleType("folder_paths")
        fp.get_input_directory = lambda: tempfile.gettempdir()
        fp.get_directory_by_type = lambda t: None
        fp.filter_files_content_types = lambda files, types_: [
            f for f in files if f.lower().endswith(IMAGE_EXT)
        ]
        fp.get_annotated_filepath = lambda name: (name, None)
        fp.exists_annotated_filepath = lambda name: os.path.isfile(name)
        sys.modules["folder_paths"] = fp

    if need_nodes:
        nd = types.ModuleType("nodes")

        class LoadImage:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {}}

            def load_image(self, image):
                return (None, None)

        nd.LoadImage = LoadImage
        sys.modules["nodes"] = nd

    return need_fp or need_nodes


USING_STUBS = _install_comfy_stubs()


def _load_node_module():
    spec = importlib.util.spec_from_file_location("lir_under_test", NODE_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lir = _load_node_module()

if lir.web is None:  # pragma: no cover
    raise unittest.SkipTest("需要 aiohttp")


# ---------------------------------------------------------------------------
# 一个临时 input 目录，结构固定
# ---------------------------------------------------------------------------

def _make_tree(root):
    """造一棵测试用目录树，返回相对路径列表（已排序）。"""
    layout = {
        "root.png": b"",
        "notes.txt": b"",              # 非图片，应被过滤掉
        "a/one.png": b"",
        "a/two.jpg": b"",
        "a/nested/deep.webp": b"",
        "b/three.png": b"",
        "clipspace/scratch.png": b"",  # 应被跳过
    }
    made = []
    for rel, _ in layout.items():
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"")
        made.append(rel)
    return sorted(made)


class CollectFilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        _make_tree(self.root)
        self.addCleanup(self.tmp.cleanup)

    def test_recurses_and_filters(self):
        files = lir._collect_files(self.root)
        self.assertIn("root.png", files)
        self.assertIn("a/one.png", files)
        self.assertIn("a/nested/deep.webp", files)
        self.assertIn("b/three.png", files)

    def test_skips_non_images(self):
        self.assertNotIn("notes.txt", lir._collect_files(self.root))

    def test_skips_clipspace(self):
        self.assertNotIn("clipspace/scratch.png", lir._collect_files(self.root))

    def test_paths_use_forward_slashes(self):
        for f in lir._collect_files(self.root):
            self.assertNotIn("\\", f)

    def test_missing_dir_is_empty_not_error(self):
        self.assertEqual(lir._collect_files(os.path.join(self.root, "nope")), [])

    def test_folders_include_every_level(self):
        folders = lir._collect_folders(lir._collect_files(self.root))
        self.assertIn("a", folders)
        self.assertIn("a/nested", folders)
        self.assertIn("b", folders)
        self.assertNotIn("clipspace", folders)


class ResolvePathTest(unittest.TestCase):
    """目录逃逸防护 —— 这块错了就是任意文件读取。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        os.makedirs(os.path.join(self.base, "sub"), exist_ok=True)
        with open(os.path.join(self.base, "sub", "x.png"), "wb") as fh:
            fh.write(b"")

        patcher = mock.patch.object(
            lir.folder_paths, "get_directory_by_type",
            side_effect=lambda t: self.base if t in ("input", "output", "temp") else None,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_normal_path_resolves(self):
        got = lir._resolve_in_type_dir("sub/x.png", "input")
        self.assertEqual(got, os.path.join(self.base, "sub", "x.png"))

    def test_parent_traversal_rejected(self):
        self.assertIsNone(lir._resolve_in_type_dir("../../etc/passwd", "input"))

    def test_traversal_that_lands_back_inside_is_ok(self):
        # sub/../sub/x.png 规范化后仍在 base 里，应当放行
        got = lir._resolve_in_type_dir("sub/../sub/x.png", "input")
        self.assertEqual(got, os.path.join(self.base, "sub", "x.png"))

    def test_absolute_path_rejected(self):
        self.assertIsNone(lir._resolve_in_type_dir("/etc/passwd", "input"))

    def test_unknown_type_rejected(self):
        self.assertIsNone(lir._resolve_in_type_dir("sub/x.png", "bogus"))


class ThumbnailTest(unittest.TestCase):
    def setUp(self):
        try:
            from PIL import Image
        except Exception:  # pragma: no cover
            raise unittest.SkipTest("需要 Pillow")
        self.Image = Image
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.big = os.path.join(self.tmp.name, "big.png")
        Image.new("RGB", (2000, 1500), (200, 40, 40)).save(self.big)

    def test_downscales_to_limit(self):
        body = lir.render_thumbnail(self.big, 384)
        with self.Image.open(__import__("io").BytesIO(body)) as im:
            self.assertEqual(max(im.size), 384)
            self.assertEqual(im.format, "WEBP")

    def test_cache_hit_returns_same_object(self):
        lir._THUMB_CACHE.clear()
        a = lir.render_thumbnail(self.big, 384)
        b = lir.render_thumbnail(self.big, 384)
        self.assertIs(a, b)

    def test_cache_key_changes_with_mtime(self):
        lir._THUMB_CACHE.clear()
        lir.render_thumbnail(self.big, 384)
        before = len(lir._THUMB_CACHE)
        os.utime(self.big, (1, 1))  # 换个 mtime
        lir.render_thumbnail(self.big, 384)
        self.assertEqual(len(lir._THUMB_CACHE), before + 1)

    def test_cache_evicts_oldest_not_everything(self):
        lir._THUMB_CACHE.clear()
        limit = lir.THUMB_CACHE_MAX
        try:
            lir.THUMB_CACHE_MAX = 2
            keys = []
            for i in range(3):
                p = os.path.join(self.tmp.name, "e%d.png" % i)
                self.Image.new("RGB", (64, 64)).save(p)
                keys.append(p)
                lir.render_thumbnail(p, 64)
            self.assertEqual(len(lir._THUMB_CACHE), 2)
            # 最旧的应该被淘汰，最新的还在
            oldest = lir._thumb_cache_key(keys[0], 64)
            self.assertNotIn(oldest, lir._THUMB_CACHE)
        finally:
            lir.THUMB_CACHE_MAX = limit
            lir._THUMB_CACHE.clear()


# ---------------------------------------------------------------------------
# middleware 分流表
# ---------------------------------------------------------------------------

class MiddlewareTest(unittest.IsolatedAsyncioTestCase):
    """起一个真的 aiohttp 服务，后面接记录型假 handler，用真 HTTP 请求打。

    这样能一次性覆盖 404 / 403 / 每条放行分支，而且比在真 ComfyUI 里点界面
    快一个数量级。
    """

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = self.tmp.name
        os.makedirs(os.path.join(self.base, "sub"), exist_ok=True)
        from PIL import Image
        self.image = os.path.join(self.base, "sub", "pic.png")
        Image.new("RGB", (1200, 900), (30, 120, 200)).save(self.image)
        self.root_image = os.path.join(self.base, "top.png")
        Image.new("RGB", (800, 600), (10, 200, 10)).save(self.root_image)

        self.patcher = mock.patch.object(
            lir.folder_paths, "get_directory_by_type",
            side_effect=lambda t: self.base if t in ("input", "output", "temp") else None,
        )
        self.patcher.start()

        self.seen = []

        async def fake_view(request):
            self.seen.append(dict(request.rel_url.query))
            return lir.web.Response(text="NATIVE", content_type="text/plain")

        app = lir.web.Application(middlewares=[lir._subfolder_view_middleware])
        app.router.add_get("/view", fake_view)
        app.router.add_get("/api/view", fake_view)

        self.runner = lir.web.AppRunner(app)
        await self.runner.setup()
        self.site = lir.web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.base_url = "http://127.0.0.1:%d" % port

        from aiohttp import ClientSession
        self.session = ClientSession()

    async def asyncTearDown(self):
        await self.session.close()
        await self.runner.cleanup()
        self.patcher.stop()
        self.tmp.cleanup()

    async def get(self, path):
        self.seen.clear()
        async with self.session.get(self.base_url + path) as resp:
            body = await resp.read()
            return resp.status, body, resp.headers.get("content-type", "")

    async def test_root_file_bare_passes_through(self):
        """根目录图的裸请求 → 不碰，保持原生行为。"""
        status, body, _ = await self.get("/api/view?filename=top.png&type=input")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"NATIVE")
        self.assertEqual(self.seen[0]["filename"], "top.png")

    async def test_subdir_bare_is_served_as_thumbnail(self):
        """子目录图的裸请求 → 原生必然 404，我们接管。"""
        status, body, ctype = await self.get("/api/view?filename=sub/pic.png&type=input")
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith("image/"))
        self.assertEqual(self.seen, [])  # 原生 handler 不该被调用

    async def test_subdir_with_channel_delegates_with_subfolder(self):
        """MaskEditor 要真实像素 → 补 subfolder 后放行。"""
        status, body, _ = await self.get(
            "/api/view?filename=sub/pic.png&type=input&channel=rgba"
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.seen[0]["filename"], "pic.png")
        self.assertEqual(self.seen[0]["subfolder"], "sub")
        self.assertEqual(self.seen[0]["channel"], "rgba")

    async def test_root_with_channel_passes_through(self):
        status, body, _ = await self.get(
            "/api/view?filename=top.png&type=input&channel=rgba"
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b"NATIVE")
        self.assertNotIn("subfolder", self.seen[0])

    async def test_subdir_with_preview_delegates_with_subfolder(self):
        status, body, _ = await self.get(
            "/api/view?filename=sub/pic.png&type=input&preview=webp;90"
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.seen[0]["subfolder"], "sub")
        self.assertEqual(self.seen[0]["preview"], "webp;90")

    async def test_max_is_honoured_by_middleware(self):
        """原生不认 max，所以带 max 的请求由我们处理 —— 省掉改 server.py。"""
        status, body, ctype = await self.get(
            "/api/view?filename=top.png&type=input&preview=webp;80&max=64"
        )
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith("image/"))
        self.assertEqual(self.seen, [])

    async def test_annotated_suffix_passes_through(self):
        status, body, _ = await self.get(
            "/api/view?filename=pic.png[input]&type=input"
        )
        self.assertEqual(body, b"NATIVE")

    async def test_unknown_type_passes_through(self):
        """未知 type 交给原生回 400，我们不该抢着回 403。"""
        status, body, _ = await self.get("/api/view?filename=sub/pic.png&type=bogus")
        self.assertEqual(body, b"NATIVE")

    async def test_missing_file_is_404(self):
        status, body, _ = await self.get("/api/view?filename=sub/nope.png&type=input")
        self.assertEqual(status, 404)

    async def test_escape_is_403(self):
        status, body, _ = await self.get("/api/view?filename=../secret.png&type=input")
        self.assertEqual(status, 403)

    async def test_other_paths_untouched(self):
        self.seen.clear()
        async with self.session.get(
            self.base_url + "/api/other?filename=sub/pic.png"
        ) as resp:
            self.assertEqual(resp.status, 404)
        self.assertEqual(self.seen, [])


class InstallMiddlewareTest(unittest.TestCase):
    """挂载函数在任何情况下都不能抛异常 —— 否则整个节点加载失败。"""

    def test_returns_false_without_server_module(self):
        fake = types.ModuleType("server")

        class PromptServer:
            instance = None

        fake.PromptServer = PromptServer
        with mock.patch.dict(sys.modules, {"server": fake}):
            self.assertFalse(lir._install_view_middleware())

    def test_refuses_when_app_frozen(self):
        app = lir.web.Application()
        app.freeze()
        fake = types.ModuleType("server")

        class PromptServer:
            instance = types.SimpleNamespace(app=app)

        fake.PromptServer = PromptServer
        with mock.patch.dict(sys.modules, {"server": fake}):
            self.assertFalse(lir._install_view_middleware())

    def test_installs_once_and_dedupes_across_reload(self):
        app = lir.web.Application()
        fake = types.ModuleType("server")

        class PromptServer:
            instance = types.SimpleNamespace(app=app)

        fake.PromptServer = PromptServer
        with mock.patch.dict(sys.modules, {"server": fake}):
            for _ in range(3):
                # 模拟热重载：模块重新执行，函数对象是新的
                module = _load_node_module()
                self.assertTrue(module._install_view_middleware())
        mine = [m for m in app.middlewares
                if getattr(m, "_load_image_recursive_middleware", False)]
        self.assertEqual(len(mine), 1)


class NodeDefinitionTest(unittest.TestCase):
    def test_folder_comes_before_image(self):
        with mock.patch.object(lir, "_collect_files", return_value=["a/x.png"]):
            spec = lir.LoadImageRecursive.INPUT_TYPES()
        self.assertEqual(list(spec["required"].keys()), ["folder", "image"])

    def test_folder_candidates_start_with_all(self):
        with mock.patch.object(lir, "_collect_files", return_value=["a/x.png"]):
            spec = lir.LoadImageRecursive.INPUT_TYPES()
        self.assertEqual(spec["required"]["folder"][0], [lir.ALL_FOLDERS, "a"])

    def test_validate_inputs_accepts_folder_kwarg(self):
        """folder 在 VALIDATE_INPUTS 签名里 → 跳过 combo 候选校验。

        这条很关键：目录被删/改名后，工作流里残留的旧目录名不该让整个
        prompt 校验失败。
        """
        with mock.patch.object(lir.folder_paths, "exists_annotated_filepath",
                               return_value=True):
            self.assertTrue(
                lir.LoadImageRecursive.VALIDATE_INPUTS("已经不存在的目录", "a/x.png")
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
