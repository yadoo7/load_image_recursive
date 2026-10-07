#!/usr/bin/env python3
"""让 combo 下拉的缩略图请求带上 `preview` + `max`，避免整张原图被拉下来。

背景
----
同一个前端里，其它所有 /view URL 生成器（mkFileUrl / buildImageUrls /
resolveFileWidgetVideoUrl / GraphView 的 buildImageUrl）都会拼上
getPreviewFormatParam()，唯独 WidgetSelect 里的 getMediaUrl() 漏了。
结果下拉里每一项都在下载原始大图 —— 根目录能显示只是因为文件小/少。

本节点自带的 middleware 只会接管「filename 里带 /」的请求（那些在原生实现下
必然 404），所以根目录的大图需要这个补丁才能走缩略图通道。

⚠️ 这个脚本会改 custom_nodes/ 以外的文件（前端打包产物），
   前端一升级就会被覆盖 —— 这也是它被标为「可选」的原因。用完可 --revert。

用法
----
    python patch_frontend_thumb.py            # 打补丁（幂等）
    python patch_frontend_thumb.py --check    # 只看状态
    python patch_frontend_thumb.py --revert   # 从备份还原

用 ComfyUI 自带的 python 跑（需要能 import comfyui_frontend_package），
或者用 --assets 直接指定产物目录。
"""
import argparse
import glob
import os
import re
import shutil
import sys

BAK_SUFFIX = ".bak-thumb"
MAX_SIDE = "384"
PREVIEW = "webp;80"

# 精确匹配（前端未升级时命中）
OLD_EXACT = (
    "function getMediaUrl(e,t,n){if(![`image`,`video`,`audio`].includes(n??``))return``;"
    "let r=new URLSearchParams({filename:e,type:t});return he(r,e),`/api/view?${r}`}"
)
NEW_EXACT = (
    "function getMediaUrl(e,t,n){if(![`image`,`video`,`audio`].includes(n??``))return``;"
    "let r=new URLSearchParams({filename:e,type:t});return he(r,e),"
    "n===`image`&&!r.has(`preview`)&&(r.set(`preview`,`%s`),r.set(`max`,`%s`)),"
    "`/api/view?${r}`}" % (PREVIEW, MAX_SIDE)
)

# 前端升级后压缩器的变量名会变，用这个兜底重建整个函数体
GEN = re.compile(
    r"function getMediaUrl\((\w+),(\w+),(\w+)\)\{(.{0,400}?)"
    r"return (\w+)\((\w+),(\w+)\),`/api/view\?\$\{(\w+)\}`\}"
)
MARKER = "r.set(`max`,"


def find_assets_dir():
    """自动定位前端打包产物目录。"""
    # 1) 能 import 到就直接问它
    try:
        import comfyui_frontend_package

        guess = os.path.join(
            os.path.dirname(comfyui_frontend_package.__file__), "static", "assets"
        )
        if os.path.isdir(guess):
            return guess
    except Exception:
        pass

    # 2) 在 sys.path 上逐个找
    for entry in sys.path:
        if not entry:
            continue
        guess = os.path.join(entry, "comfyui_frontend_package", "static", "assets")
        if os.path.isdir(guess):
            return guess

    # 3) 从脚本位置往上找 ComfyUI 根，再看常见布局
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        here = os.path.dirname(here)
        if os.path.isfile(os.path.join(here, "main.py")):
            for sub in ("python_embeded", "venv", ".venv", "python_dapao313"):
                guess = os.path.join(
                    here, sub, "Lib", "site-packages",
                    "comfyui_frontend_package", "static", "assets",
                )
                if os.path.isdir(guess):
                    return guess
            break
    return None


def build_generic(m):
    a, b, kind, head, helper, r1, r2, obj = m.groups()
    return (
        "function getMediaUrl(%s,%s,%s){%s"
        "return %s(%s,%s),%s===`image`&&!%s.has(`preview`)&&"
        "(%s.set(`preview`,`%s`),%s.set(`max`,`%s`)),`/api/view?${%s}`}"
        % (a, b, kind, head, helper, r1, r2, kind, obj, obj, PREVIEW, obj, MAX_SIDE, obj)
    )


def targets(assets):
    return sorted(glob.glob(os.path.join(assets, "*.js")))


def status_of(path):
    s = open(path, encoding="utf-8", errors="replace").read()
    if MARKER in s:
        return "patched"
    if "function getMediaUrl(" in s:
        return "unpatched"
    return "n/a"


def do_check(assets):
    found = False
    for p in targets(assets):
        st = status_of(p)
        if st != "n/a":
            found = True
            print("  %-44s %s" % (os.path.basename(p), st))
    if not found:
        print("  !! 没有任何产物含 getMediaUrl，前端结构可能变了")


def do_patch(assets):
    changed = 0
    for p in targets(assets):
        s = open(p, encoding="utf-8", errors="replace").read()
        if "function getMediaUrl(" not in s:
            continue
        if MARKER in s:
            print("  已打过，跳过：%s" % os.path.basename(p))
            continue

        if OLD_EXACT in s:
            new, how = s.replace(OLD_EXACT, NEW_EXACT, 1), "精确匹配"
        else:
            m = GEN.search(s)
            if not m:
                print("  !! 找不到可替换的函数体：%s" % os.path.basename(p))
                continue
            new, how = s[: m.start()] + build_generic(m) + s[m.end():], "正则重建"

        bak = p + BAK_SUFFIX
        if not os.path.exists(bak):
            shutil.copy2(p, bak)
            print("  备份 -> %s" % os.path.basename(bak))
        with open(p, "w", encoding="utf-8", newline="") as fh:
            fh.write(new)
        print("  已打补丁（%s）：%s  %d -> %d 字节"
              % (how, os.path.basename(p), len(s), len(new)))
        changed += 1

    if changed == 0:
        print("  没有任何改动")
    else:
        print("\n完成，改了 %d 个文件。浏览器需要 Ctrl+F5 硬刷新。" % changed)


def do_revert(assets):
    n = 0
    for bak in sorted(glob.glob(os.path.join(assets, "*" + BAK_SUFFIX))):
        orig = bak[: -len(BAK_SUFFIX)]
        shutil.copy2(bak, orig)
        os.remove(bak)
        print("  已还原：%s" % os.path.basename(orig))
        n += 1
    print("还原 %d 个文件" % n if n else "没有找到备份，无需还原")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--revert", action="store_true", help="从备份还原")
    ap.add_argument("--check", action="store_true", help="只查看状态")
    ap.add_argument("--assets", help="手动指定前端产物目录")
    args = ap.parse_args()

    assets = args.assets or find_assets_dir()
    if not assets or not os.path.isdir(assets):
        print("找不到前端产物目录。用 --assets 手动指定，例如：")
        print("  --assets <ComfyUI>/python_embeded/Lib/site-packages/"
              "comfyui_frontend_package/static/assets")
        return 1

    print("前端产物目录：%s\n" % assets)
    if args.check:
        do_check(assets)
    elif args.revert:
        do_revert(assets)
    else:
        do_patch(assets)
    return 0


if __name__ == "__main__":
    sys.exit(main())
