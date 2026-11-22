/**
 * 加载图片（含子目录）的附加功能 —— 右键菜单版。
 *
 * 五个功能全部从节点右键菜单进，刻意不做任何 DOM 注入、
 * 也不碰 combo 的 options.values（方向过滤除外，见下）：
 * 之前那版往 widget DOM 里塞按钮、往下拉上盖覆盖层，
 * 跟原生渲染冲突，把节点整个搞挂过。菜单是 folderFilter.js
 * 自己也在用的注入点，最安全。
 *
 *   ⭐ 收藏当前目录 / 书签列表 / 删除书签
 *   ⏱ 最近使用（点击直接选中那张图）
 *   🖼 只看横图 / 竖图 / 显示全部
 *   📷 图片信息 (EXIF)
 *   ⬇ 导出当前遮罩到 output（仅在遮罩编辑器成品上出现）
 *
 * 与 folderFilter 的分工：
 *   - 切目录 / 选图一律走 widget.setValue 的正规路（value + callback），
 *     让 folderFilter 自己的 callback 链去做列表过滤和预览跟随。
 *   - 方向过滤是唯一动 options.values 的地方：先快照，恢复时
 *     触发一次 folder callback 让 applyFilter 重放，列表必然回到正确状态。
 */

import { app } from "../../../scripts/app.js";

const NODE_NAME = "LoadImageRecursive";
const RECENT_KEY = "lir_recent";
const RECENT_MAX = 20;
const BOOKMARKS_KEY = "lir_bookmarks";

// ===========================================================================
// 通用工具
// ===========================================================================

/** "子目录/文件.jpg" -> { filename, subfolder }；带 " [input]" 后缀也能解。 */
function _parseWidgetValue(value) {
  if (typeof value !== "string") return null;
  let path = value.trim();
  const cut = path.lastIndexOf(" [");
  if (cut !== -1) path = path.slice(0, cut);
  if (!path) return null;
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { filename: path, subfolder: "" }
    : { filename: path.slice(slash + 1), subfolder: path.slice(0, slash) };
}

function _readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function _writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 存储满了之类，功能降级即可 */ }
}

/** 右下角 toast，支持多行（\n）。 */
function _toast(msg, ms = 3200) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:99999;padding:10px 16px;" +
    "border-radius:8px;background:#1f6f6b;color:#eafafa;max-width:420px;" +
    "font:13px/1.6 system-ui,sans-serif;white-space:pre-line;" +
    "box-shadow:0 8px 28px rgba(0,0,0,0.45);opacity:0;transition:opacity .4s ease;";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = "1"; });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, ms);
}

function _adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 编码 RGBA PNG（手写 PNG chunk，与 maskEditor 的 encodePng 同思路）。 */
async function _encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  let compressed = null;
  if (typeof CompressionStream !== "undefined") {
    const cs = new CompressionStream("deflate");
    const writer = cs.writable.getWriter();
    void writer.write(raw).catch(() => {});
    void writer.close().catch(() => {});
    const reader = cs.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    compressed = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { compressed.set(c, off); off += c.length; }
  }
  if (!compressed || !compressed.length) {
    // 无 CompressionStream 的环境退到 zlib stored block（不压缩但合法）
    const stored = new Uint8Array(
      2 + raw.length + Math.ceil(raw.length / 65535) * 5
    );
    let p = 0;
    stored[p++] = 0x78; stored[p++] = 0x01;
    let i = 0;
    while (i < raw.length) {
      const end = Math.min(i + 65535, raw.length);
      const block = raw.subarray(i, end);
      const last = end >= raw.length;
      stored[p++] = last ? 1 : 0;
      stored[p++] = block.length & 0xff;
      stored[p++] = (block.length >> 8) & 0xff;
      stored[p++] = (~block.length) & 0xff;
      stored[p++] = ((~block.length) >> 8) & 0xff;
      stored.set(block, p); p += block.length;
      i = end;
    }
    const dv = new DataView(stored.buffer);
    dv.setUint32(p, _adler32(raw));
    compressed = stored.subarray(0, p + 4);
  }

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const _crc = (d) => {
    let c = 0xffffffff;
    for (let i = 0; i < d.length; i++) c = _crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const _chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const od = new DataView(out.buffer);
    od.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    od.setUint32(8 + data.length, _crc(out.subarray(4, 8 + data.length)));
    return out;
  };

  const parts = [sig, _chunk("IHDR", ihdr), _chunk("IDAT", compressed), _chunk("IEND", new Uint8Array(0))];
  return new Blob(parts, { type: "image/png" });
}

// ===========================================================================
// 最近使用
// ===========================================================================

function _addRecentEntry(filepath) {
  if (typeof filepath !== "string" || !filepath) return;
  let recent = _readJson(RECENT_KEY, []);
  if (!Array.isArray(recent)) recent = [];
  recent = recent.filter((p) => p !== filepath);
  recent.unshift(filepath);
  recent = recent.slice(0, RECENT_MAX);
  _writeJson(RECENT_KEY, recent);
}

// ===========================================================================
// 书签
// ===========================================================================

function _getBookmarks() {
  const bms = _readJson(BOOKMARKS_KEY, []);
  return Array.isArray(bms) ? bms.filter((b) => typeof b === "string") : [];
}

function _addBookmark(path) {
  if (typeof path !== "string" || !path) return;
  const bms = _getBookmarks();
  if (!bms.includes(path)) {
    bms.push(path);
    _writeJson(BOOKMARKS_KEY, bms);
  }
}

function _removeBookmark(path) {
  _writeJson(BOOKMARKS_KEY, _getBookmarks().filter((p) => p !== path));
}

// ===========================================================================
// 图片尺寸（方向过滤用，带 localStorage 缓存）
// ===========================================================================

async function _getImageDims(filepath) {
  const key = "lir_dim_" + filepath;
  const cached = _readJson(key, null);
  if (cached && cached.w > 0) return cached;

  const parsed = _parseWidgetValue(filepath) ?? { filename: filepath, subfolder: "" };
  // max=256 走插件 middleware 的缩略图分支，不会把 52MP 原图整张拉下来。
  // 缩小不影响 w/h 的大小关系，方向判断照样成立。
  const url =
    "/view?filename=" + encodeURIComponent(parsed.filename) +
    "&subfolder=" + encodeURIComponent(parsed.subfolder) +
    "&type=input&max=256";
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("load failed"));
      im.src = url;
    });
    const dims = { w: img.naturalWidth, h: img.naturalHeight };
    if (dims.w > 0) _writeJson(key, dims);
    return dims;
  } catch {
    return null;
  }
}

// ===========================================================================
// EXIF
// ===========================================================================

const EXIF_CACHE = new Map();

async function _showExif(imageWidget) {
  const parsed = _parseWidgetValue(imageWidget.value);
  if (!parsed) { _toast("当前没有选中图片"); return; }
  const path = parsed.subfolder ? parsed.subfolder + "/" + parsed.filename : parsed.filename;

  let data = EXIF_CACHE.get(path);
  if (!data) {
    try {
      const resp = await fetch(
        "/lir/exif?filename=" + encodeURIComponent(parsed.filename) +
        "&subfolder=" + encodeURIComponent(parsed.subfolder) + "&type=input"
      );
      data = await resp.json();
    } catch (err) {
      data = { error: String(err) };
    }
    EXIF_CACHE.set(path, data);
  }

  if (data.error) {
    _toast(`📷 ${parsed.filename}\n这张图没有可读的拍摄参数（EXIF）`);
    return;
  }
  const lines = [
    `📷 ${parsed.filename}`,
    data.focal_length ? `焦距  ${data.focal_length}` : null,
    data.aperture ? `光圈  ${data.aperture}` : null,
    data.shutter ? `快门  ${data.shutter}` : null,
    data.iso ? `ISO   ${data.iso}` : null,
  ].filter(Boolean);
  _toast(lines.join("\n"), 5000);
}

// ===========================================================================
// 导出遮罩
// ===========================================================================

async function _exportCurrentMask(imageWidget) {
  const parsed = _parseWidgetValue(imageWidget.value);
  if (!parsed) return;
  const viewUrl =
    "/view?filename=" + encodeURIComponent(parsed.filename) +
    "&subfolder=" + encodeURIComponent(parsed.subfolder) + "&type=input";
  try {
    const resp = await fetch(viewUrl);
    if (!resp.ok) { _toast("读不到遮罩文件，导出失败"); return; }
    const blob = await resp.blob();
    const img = await createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, img.width, img.height);

    // 优先取 alpha 作为遮罩灰度（MaskEditor 成品把遮罩存在 alpha 通道），
    // 整张 alpha 全 255 时退回 R 通道。
    let hasAlpha = false;
    for (let i = 3; i < id.data.length; i += 4) {
      if (id.data[i] !== 255) { hasAlpha = true; break; }
    }
    const rgba = new Uint8ClampedArray(img.width * img.height * 4);
    for (let i = 0; i < rgba.length / 4; i++) {
      const v = hasAlpha ? id.data[i * 4 + 3] : id.data[i * 4];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = v;
    }

    const pngBlob = await _encodePng(img.width, img.height, rgba);
    const fd = new FormData();
    fd.append("image", pngBlob, "mask.png");
    const up = await fetch("/lir/export-mask", { method: "POST", body: fd });
    if (!up.ok) { _toast("导出失败（后端返回 " + up.status + "）"); return; }
    const result = await up.json();
    _toast(`⬇ 遮罩已导出\noutput/${result.filename}\n黑白 PNG，AE/剪映可直接当 Matte 用`, 5000);
  } catch (err) {
    _toast("导出异常：" + err);
  }
}

// ===========================================================================
// 主扩展
// ===========================================================================

app.registerExtension({
  name: "xiaowang.LoadImageRecursive.Extras",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;
      const folderWidget = node.widgets?.find((w) => w.name === "folder");
      const imageWidget = node.widgets?.find((w) => w.name === "image");
      if (!folderWidget || !imageWidget) return r;

      // ---- 状态 -----------------------------------------------------------
      let baseValues = null; // 方向过滤前的列表快照（null = 未在过滤中）

      // 记录最近使用：图片值一变就记。包在 folderFilter 包装的外面，
      // 纯记录、不改行为。
      const prevImageCb = imageWidget.callback;
      imageWidget.callback = function (value, ...rest) {
        const result = prevImageCb?.apply(this, [value, ...rest]);
        if (typeof value === "string" && value) _addRecentEntry(value);
        return result ?? value;
      };

      // 切了目录就结束方向过滤（applyFilter 重放会重设列表，快照作废）
      const prevFolderCb = folderWidget.callback;
      folderWidget.callback = function (value, ...rest) {
        const result = prevFolderCb?.apply(this, [value, ...rest]);
        baseValues = null;
        return result ?? value;
      };

      // ---- 方向过滤 --------------------------------------------------------
      const pickValue = (value) => {
        // __lirSkipFolderSync 是 folderFilter 认的标记：置位期间它跳过
        // 「图片 → 目录」反向同步和 applyFilter 重放，方向过滤的临时视图
        // 才不会被冲掉。字段名改了要两边一起改。
        imageWidget.__lirSkipFolderSync = true;
        try {
          imageWidget.value = value;
          imageWidget.callback?.(value);
        } finally {
          imageWidget.__lirSkipFolderSync = false;
        }
      };

      const applyOrientation = async (mode) => {
        const source = baseValues || imageWidget.options?.values;
        if (!Array.isArray(source) || !source.length) {
          _toast("当前列表是空的，没法按方向过滤");
          return;
        }
        if (!baseValues) baseValues = source.slice();

        const keep = [];
        for (const f of baseValues) {
          const d = await _getImageDims(f);
          if (!d) continue;
          if (mode === "landscape" && d.w >= d.h) keep.push(f);
          if (mode === "portrait" && d.w < d.h) keep.push(f);
        }
        // 等尺寸的期间用户切了目录（callback 会清 baseValues），别覆盖新列表
        if (baseValues === null) return;

        imageWidget.options.values = keep;
        if (!keep.includes(imageWidget.value)) {
          if (keep.length) pickValue(keep[0]);
          else {
            baseValues = null;
            folderWidget.callback?.(folderWidget.value);
          }
        }
        app.graph?.setDirtyCanvas(true, true);
        _toast(keep.length ? `已过滤：${keep.length} 张${mode === "landscape" ? "横" : "竖"}图` : "没有符合条件的图，已恢复");
      };

      const clearOrientation = () => {
        const wasFiltered = baseValues !== null;
        baseValues = null;
        // 让 folderFilter 的 applyFilter 从全集重放，列表必然回到正确状态
        folderWidget.callback?.(folderWidget.value);
        if (wasFiltered) app.graph?.setDirtyCanvas(true, true);
      };

      // ---- 右键菜单 --------------------------------------------------------
      const prevMenu = nodeType.prototype.getExtraMenuOptions;
      nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        const result = prevMenu?.apply(this, arguments);
        const folderValue = typeof folderWidget.value === "string" ? folderWidget.value : "";

        // ⭐ 书签
        options.push(null, {
          content: "⭐ 收藏当前目录",
          callback: () => {
            if (!folderValue || folderValue === "(全部)" || folderValue === "(根目录)") {
              _toast("先在目录下拉里选中一个具体目录再收藏");
              return;
            }
            _addBookmark(folderValue);
            _toast(`已收藏：${folderValue}`);
          },
        });
        const bms = _getBookmarks();
        for (const b of bms) {
          options.push({
            content: `📁 ${b}`,
            callback: () => {
              folderWidget.value = b;
              folderWidget.callback?.(b);
              app.graph?.setDirtyCanvas(true, true);
            },
          });
        }
        if (bms.length) {
          options.push({
            content: "🗑 删除书签…",
            callback: () => {
              const list = _getBookmarks();
              const msg =
                "现有书签：\n" + list.map((b, i) => `${i + 1}. ${b}`).join("\n") +
                "\n\n输入要删除的序号（逗号分隔），留空取消：";
              const input = prompt(msg, "");
              if (!input) return;
              const idx = input
                .split(",")
                .map((s) => parseInt(s.trim(), 10) - 1)
                .filter((n) => Number.isInteger(n) && n >= 0 && n < list.length);
              if (!idx.length) return;
              for (const i of [...new Set(idx)].sort((a, b) => b - a)) _removeBookmark(list[i]);
              _toast(`已删除 ${idx.length} 个书签`);
            },
          });
        }

        // ⏱ 最近使用
        const recent = _readJson(RECENT_KEY, []);
        if (Array.isArray(recent) && recent.length) {
          options.push(null, {
            content: `⏱ 最近使用（${recent.length}）`,
            disabled: true,
          });
          for (const f of recent.slice(0, 8)) {
            options.push({
              content: `　${f}`,
              callback: () => {
                imageWidget.value = f;
                imageWidget.callback?.(f);
                app.graph?.setDirtyCanvas(true, true);
              },
            });
          }
        }

        // 🖼 方向过滤
        options.push(null, { content: "🖼 只看横图", callback: () => applyOrientation("landscape") });
        options.push({ content: "🖼 只看竖图", callback: () => applyOrientation("portrait") });
        options.push({ content: "🖼 显示全部", callback: () => clearOrientation() });

        // 📷 EXIF
        options.push(null, {
          content: "📷 图片信息 (EXIF)",
          callback: () => _showExif(imageWidget),
        });

        // ⬇ 导出遮罩（仅遮罩编辑器成品）
        const v = imageWidget.value;
        if (typeof v === "string" && v.includes("clipspace-painted-masked")) {
          options.push(null, {
            content: "⬇ 导出当前遮罩到 output",
            callback: () => _exportCurrentMask(imageWidget),
          });
        }

        return result;
      };
      return r;
    };
  },
});
