/**
 * 「遮罩」编辑器 —— 挂在「加载图片(含子目录)」节点上的轻量画笔。
 *
 * 为什么不用 ComfyUI 原生 MaskEditor：那套是全屏 Vue dialog，得走右键菜单进去，
 * 画笔手感也重。这里做成节点上的一个按钮 + 一个贴脸的浮层，四件事照搬
 * Goohaitools 那套让人觉得轻松的设计：
 *
 *   1. 仅遮罩视图   —— 只看黑白涂到哪，不被照片干扰
 *   2. 自动填充漏洞 —— 描个封闭轮廓就填满，不用来回抹
 *   3. 右键拖动画布 —— 手不用离开去摸设置面板
 *   4. 轻量浮层     —— 不是 modal，Esc 直接走
 *
 * 存盘契约与 ComfyUI 原生 MaskEditor **完全一致**（这是故意的，见下方说明）：
 *
 *   · 文件落在 input/clipspace/ 下，命名 clipspace-painted-masked-{ts}.png
 *   · RGB = 原图，alpha = 255 - mask（白色画笔涂过的地方变透明）
 *   · image widget 的值写成 `clipspace/clipspace-painted-masked-{ts}.png [input]`
 *
 * 所以后端一行不用改：原生 LoadImage 的 mask 就是 `1 - alpha`，
 * 两边严丝合缝。附带的好处是原生编辑器存的文件这里也认得，能打开接着涂。
 *
 * 操作：左键画 · 右键拖动调笔刷 · 滚轮缩放 · 空格或中键拖动平移 · Esc 取消
 */

import { app } from "../../../scripts/app.js";

const NODE_NAME = "LoadImageRecursive";

// 遮罩不用原图分辨率。2048 足够 inpainting 用，还能把「自动填充漏洞」的
// flood fill 从几千万像素压到四百万以内 —— 那是唯一可能卡的步骤。
const MASK_MAX_SIDE = 2048;

// 跟原生 MaskEditor 的命名逐字一致，换来「互相认得」。
const MASKED_PREFIX = "clipspace-painted-masked-";
const CLIPSPACE_DIR = "clipspace";

const BRUSH_DEFAULT = 30;
const BRUSH_MIN = 2;
const BRUSH_MAX = 400;

const HINT_DEFAULT =
  "左键绘制 · 右键左右拖动调笔刷 · 滚轮缩放 · 空格或中键拖动平移 · Esc 取消";

// 「颜色叠加」模式下遮罩的染色。比纯绿亮一点，压在暗部照片上也看得清。
const MASK_COLOR = "#2ee88a";
const MASK_ALPHA = 0.5;

// 显示在工具条右上角。浏览器缓存住的旧版 js 从外观上完全看不出来，
// 有这个标记就能一眼确认「到底刷没刷新」。
// 每改一次 JS 就把 build 号 +1 —— 光靠 1.0.5 区分不了同版本内的多次修改。
const BUILD = "1.0.5.3";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

/**
 * 把 widget 的值拆成文件名 + 子目录。
 * 认三种写法：`a/b.png`、`a/b.png [input]`、`b.png [input]`。
 */
function parseWidgetValue(value) {
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

function isMaskedValue(value) {
  if (typeof value !== "string") return false;
  const parsed = parseWidgetValue(value);
  return !!parsed && parsed.filename.startsWith(MASKED_PREFIX);
}

/** 原图的 /view 地址。带 channel=rgb 是为了绕过我们自己的缩略图 middleware。 */
function sourceImageUrl(parsed) {
  const params = new URLSearchParams({
    filename: parsed.filename,
    subfolder: parsed.subfolder,
    type: "input",
    channel: "rgb",
  });
  return "/view?" + params.toString();
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

/**
 * 为什么不能直接用 canvas.toBlob()。
 *
 * canvas 的位图是 premultiplied alpha 的：一旦把某个像素的 alpha 写成 0，
 * 它的 RGB 就已经被乘成 0 了，之后无论怎么读都是黑。而我们存盘的要求
 * 恰好是「mask 涂过的地方 alpha=0，但 RGB 保持原图」—— 因为后端只认
 * alpha，前端重新打开编辑器时还要靠 RGB 当底图。
 *
 * 所以这里从 ImageData 直接编码 PNG，完全绕开 canvas 位图。
 * ComfyUI 原生的 MaskEditor 也是这么干的（见 useMaskEditorSaver.ts 里
 * encodeRgbaAsPng 的注释，同一个坑）。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  // 不 await write —— 大图时背压会让这里卡住；fire-and-forget 再由 close 兜住
  void writer.write(bytes).catch(() => {});
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
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** rgba: Uint8ClampedArray，长度 w*h*4。返回 PNG Blob。 */
async function encodePng(w, h, rgba) {
  const stride = w * 4;
  // 每行前面加一个 filter byte（0 = None）
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const compressed = await deflateRaw(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [sig, pngChunk("IHDR", ihdr)];
  if (compressed) {
    parts.push(pngChunk("IDAT", compressed));
  } else {
    // 没有 CompressionStream 的老浏览器：zlib stored block（不压缩，只包壳）
    const n = raw.length;
    const blocks = [];
    const maxBlock = 0xffff;
    let off = 0;
    while (off < n) {
      const len = Math.min(maxBlock, n - off);
      const isLast = off + len >= n ? 1 : 0;
      const bh = new Uint8Array(5);
      bh[0] = isLast;
      bh[1] = len & 0xff;
      bh[2] = (len >> 8) & 0xff;
      bh[3] = ~len & 0xff;
      bh[4] = (~len >> 8) & 0xff;
      blocks.push(bh, raw.subarray(off, off + len));
      off += len;
    }
    const adler = adler32(raw);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, adler);
    const stored = new Uint8Array(
      blocks.reduce((s, b) => s + b.length, 0) + 4
    );
    let p = 0;
    for (const b of blocks) {
      stored.set(b, p);
      p += b.length;
    }
    stored.set(tail, p);
    // zlib 头：CM=8, CINFO=7, FCHECK 让头两字节对 31 取模为 0
    parts.push(pngChunk("IDAT", new Uint8Array([0x78, 0x01, ...stored])));
  }
  parts.push(pngChunk("IEND", new Uint8Array(0)));

  return new Blob(parts, { type: "image/png" });
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// 自动填充漏洞
// ---------------------------------------------------------------------------

/**
 * 把 mask 里被完全围住的空洞填掉。
 *
 * 做法：从画布四边往里做一次 flood fill，只走「未涂（值 0）」的像素，
 * 能到达的就是外部；剩下到不了的就是漏洞 —— 把它们涂上。
 *
 * 用显式栈不用递归：52MP 的图递归深度能直接爆调用栈。
 *
 * rgba 是 `ImageData.data`，**每像素 4 字节**。这里必须先把 R 通道抽成灰度
 * 再算索引 —— 直接拿 RGBA 数组当灰度用的话，索引会整体错位：`seen` 只有
 * w*h 长，而 `data.length` 是 w*h*4，i 一超过 w*h，`seen[i]` 恒为 undefined，
 * 于是图的下 3/4 里所有值为 0 的通道字节（也就是所有黑色像素）都会被刷成
 * 255 —— 表现为「随手画一笔，下面大半张图全变白」。
 */
function fillEnclosedHoles(rgba, w, h) {
  const n = w * h;
  const gray = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = rgba[p];

  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;

  const pushIfOpen = (i) => {
    if (gray[i] === 0 && !seen[i]) {
      seen[i] = 1;
      stack[top++] = i;
    }
  };

  // 四边入栈
  for (let x = 0; x < w; x++) {
    pushIfOpen(x);
    pushIfOpen((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    pushIfOpen(y * w);
    pushIfOpen(y * w + w - 1);
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    if (x > 0) pushIfOpen(i - 1);
    if (x < w - 1) pushIfOpen(i + 1);
    if (i >= w) pushIfOpen(i - w);
    if (i < n - w) pushIfOpen(i + w);
  }

  // 没被标记又不是已涂 → 漏洞
  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (gray[i] === 0 && !seen[i]) {
      const p = i * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = rgba[p + 3] = 255;
      filled++;
    }
  }
  return filled;
}

/** 数一下 mask 里涂了多少像素（取 R 通道 > 127）。 */
function countPainted(rgba) {
  let c = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 127) c++;
  return c;
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

const STYLE = `
.lir-mask-root {
  position: fixed; inset: 0; z-index: 100000;
  /* ComfyUI 有条全局规则会把 body 下的容器设成 pointer-events: none，
     不显式打开的话整个浮层点不到 —— 事件会直接穿透到下面的画布上。 */
  pointer-events: auto;
  background: rgba(8, 9, 12, 0.82);
  display: flex; flex-direction: column;
  font: 13px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #dcdcdc;
}
.lir-mask-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: #1b1c20; border-bottom: 1px solid #2e3036;
  flex-wrap: wrap;
}
.lir-mask-bar .spacer { flex: 1; }
.lir-mask-stage { position: relative; flex: 1; overflow: hidden; }
.lir-mask-stage canvas {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; touch-action: none;
}
.lir-mask-hint {
  padding: 6px 12px; background: #14151a; border-top: 1px solid #2e3036;
  color: #8b8e96; font-size: 12px;
}
.lir-mask-btn {
  appearance: none; border: 1px solid #3a3d45; background: #26282e;
  color: #dcdcdc; border-radius: 6px; padding: 5px 11px;
  font: inherit; cursor: pointer; white-space: nowrap;
}
.lir-mask-btn:hover { background: #31343b; }
.lir-mask-btn[aria-pressed="true"] {
  background: #1f6f6b; border-color: #2a8f8a; color: #eafafa;
}
.lir-mask-btn.primary { background: #1f6f6b; border-color: #2a8f8a; color: #eafafa; }
.lir-mask-btn.primary:hover { background: #24827d; }
.lir-mask-btn.danger:hover { background: #6b2b2b; border-color: #8d3a3a; }
.lir-mask-size { color: #9aa0aa; font-variant-numeric: tabular-nums; min-width: 52px; }
.lir-mask-ver {
  color: #6b7078; font-size: 11px; font-variant-numeric: tabular-nums;
  padding-left: 4px; user-select: none;
}
.lir-mask-toggle { display: flex; border: 1px solid #3a3d45; border-radius: 6px; overflow: hidden; }
.lir-mask-toggle .lir-mask-btn { border: 0; border-radius: 0; }
.lir-mask-cursor {
  position: absolute; border: 1px solid #fff; border-radius: 50%;
  pointer-events: none; mix-blend-mode: difference; display: none;
}
.lir-mask-toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 100001;
  max-width: 420px; padding: 10px 16px; border-radius: 8px;
  background: #1f6f6b; border: 1px solid #2a8f8a; color: #eafafa;
  font: 13px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  transition: opacity 0.4s ease;
}
`;

function ensureStyle() {
  if (document.getElementById("lir-mask-style")) return;
  const el = document.createElement("style");
  el.id = "lir-mask-style";
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------------------

class MaskEditor {
  constructor() {
    this.root = null;
    this.onSave = null;
    this.baseImg = null;
    this.mask = null; // 离屏灰度 canvas：黑=未涂，白=已涂
    this.tinted = null; // 绿色版 mask 缓存，「颜色叠加」模式用
    this.tintedDirty = true;
    this.tool = "brush";
    // 默认「颜色叠加」而不是「仅遮罩」。
    // 仅遮罩视图只画灰度遮罩、不画照片，一打开就是一张纯黑 ——
    // 谁第一次看到都会以为节点坏了（东爷 2026-10-25 就报了这个）。
    // 颜色叠加能直接看到原图 + 绿色涂抹，才是能上手的状态；
    // 需要抠细节时再切到仅遮罩。
    this.mode = "color";
    this.autoFill = true;
    this.brushSize = BRUSH_DEFAULT;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.spaceDown = false;
    this.panning = false;
    this.resizing = false;
    this.drawing = false;
    this.last = null;
    this.dirty = false;
    this.emptyWarned = false;
  }

  // ---- 打开 / 关闭 --------------------------------------------------------

  async open({ value, onSave }) {
    const parsed = parseWidgetValue(value);
    if (!parsed) {
      console.warn("[LoadImageRecursive] 遮罩编辑器：当前没有选中图片");
      return;
    }
    this.onSave = onSave;

    let img;
    try {
      img = await loadImage(sourceImageUrl(parsed));
    } catch (err) {
      console.warn("[LoadImageRecursive] 遮罩编辑器：原图加载失败", err);
      return;
    }

    this.baseImg = img;
    this.buildMask(img, isMaskedValue(value));
    // 样式必须在 buildDom 之前挂 —— buildDom 结尾会 resizeView() 去量
    // .lir-mask-stage 的尺寸，而 flex 布局、canvas 的 width/height:100%
    // 全靠这份样式。顺序反了量到的是「没有 CSS」的默认布局：canvas 还是
    // 浏览器默认的 300×150，于是 vw/vh 记成 1500×154，fitToScreen 算出的
    // scale 只有 0.07 —— 之后每一笔的坐标都被映射到遮罩画布外面，一笔都
    // 画不进去，存出来 alpha 全 255，后端 mask = 1 - alpha 就是全黑。
    ensureStyle();
    this.buildDom();
    this.fitToScreen();
    this.render();
    // 字体加载 / flex 重排可能还要再稳一帧，尺寸真变了就重算一次
    requestAnimationFrame(() => {
      if (!this.root) return;
      const r = this.stage.getBoundingClientRect();
      if (Math.abs(r.width - this.vw) > 1 || Math.abs(r.height - this.vh) > 1) {
        this.resizeView();
        this.fitToScreen();
        this.render();
      }
    });
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
  }

  close() {
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    this.root?.remove();
    this.root = null;
    this.baseImg = null;
  }

  /**
   * 建 mask 画布。
   * 之前存过的成品要接着涂 —— 从 alpha 反算：mask = 255 - alpha。
   * 普通图片一律从全黑开始（哪怕它自己带 alpha，那也不是遮罩）。
   */
  buildMask(img, restoreFromAlpha) {
    const ratio = Math.min(1, MASK_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * ratio));
    const h = Math.max(1, Math.round(img.naturalHeight * ratio));

    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.fillStyle = "#000";
    cx.fillRect(0, 0, w, h);

    if (restoreFromAlpha) {
      // 原图缩到 mask 尺寸后直接读它的 alpha。
      // 千万别先按原尺寸读出来再拿小图索引去查 —— 超过 MASK_MAX_SIDE 的图
      // 两个尺寸对不上，索引整体错位，还原出来的遮罩完全是乱的。
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const tctx = tmp.getContext("2d", { willReadFrequently: true });
      tctx.drawImage(img, 0, 0, w, h);
      const sd = tctx.getImageData(0, 0, w, h).data;

      const id = cx.getImageData(0, 0, w, h);
      const md = id.data;
      let anyMask = false;
      for (let i = 0; i < sd.length; i += 4) {
        const m = 255 - sd[i + 3] > 128 ? 255 : 0;
        md[i] = md[i + 1] = md[i + 2] = m;
        md[i + 3] = 255;
        if (m) anyMask = true;
      }
      if (anyMask) cx.putImageData(id, 0, 0);
      else {
        cx.fillStyle = "#000";
        cx.fillRect(0, 0, w, h);
      }
    }

    this.mask = c;
    this.tintedDirty = true;
  }

  // ---- DOM ---------------------------------------------------------------

  buildDom() {
    const root = document.createElement("div");
    root.className = "lir-mask-root";

    root.innerHTML = `
      <div class="lir-mask-bar">
        <button class="lir-mask-btn" data-act="brush" aria-pressed="true">画笔</button>
        <button class="lir-mask-btn" data-act="eraser" aria-pressed="false">橡皮</button>
        <span class="lir-mask-size" data-role="size">${this.brushSize}px</span>
        <span class="spacer"></span>
        <div class="lir-mask-toggle">
          <button class="lir-mask-btn" data-act="mode-color" aria-pressed="true">颜色叠加</button>
          <button class="lir-mask-btn" data-act="mode-mask" aria-pressed="false">仅遮罩</button>
        </div>
        <button class="lir-mask-btn" data-act="autofill" aria-pressed="true">自动填充漏洞</button>
        <button class="lir-mask-btn" data-act="invert">反转</button>
        <button class="lir-mask-btn danger" data-act="clear">清空</button>
        <button class="lir-mask-btn" data-act="cancel">取消</button>
        <button class="lir-mask-btn primary" data-act="save">保存遮罩</button>
        <span class="lir-mask-ver" data-role="ver">v${BUILD}</span>
      </div>
      <div class="lir-mask-stage" data-role="stage">
        <canvas data-role="view"></canvas>
        <div class="lir-mask-cursor" data-role="cursor"></div>
      </div>
      <div class="lir-mask-hint" data-role="hint">${HINT_DEFAULT}</div>
    `;

    this.root = root;
    this.stage = root.querySelector('[data-role="stage"]');
    this.view = root.querySelector('[data-role="view"]');
    this.cursor = root.querySelector('[data-role="cursor"]');
    this.sizeLabel = root.querySelector('[data-role="size"]');
    this.hint = root.querySelector('[data-role="hint"]');
    this.vctx = this.view.getContext("2d");

    root.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act) this.onAction(act, e.target);
    });
    this.stage.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.stage.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.stage.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.stage.addEventListener("pointercancel", () => this.endStroke());
    this.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener("pointerleave", () => {
      this.cursor.style.display = "none";
    });
    this.stage.addEventListener("contextmenu", (e) => e.preventDefault());

    document.body.appendChild(root);
    this.resizeView();
    window.addEventListener("resize", this.onWindowResize);
  }

  onWindowResize = () => {
    if (!this.root) return;
    this.resizeView();
    this.render();
  };

  resizeView() {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.view.width = Math.max(1, Math.round(r.width * dpr));
    this.view.height = Math.max(1, Math.round(r.height * dpr));
    this.vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.vw = r.width;
    this.vh = r.height;
  }

  // ---- 视图变换 ----------------------------------------------------------

  fitToScreen() {
    if (!this.baseImg) return;
    const s = Math.min(
      (this.vw - 48) / this.baseImg.naturalWidth,
      (this.vh - 48) / this.baseImg.naturalHeight
    );
    this.scale = s > 0 ? s : 1;
    this.ox = (this.vw - this.baseImg.naturalWidth * this.scale) / 2;
    this.oy = (this.vh - this.baseImg.naturalHeight * this.scale) / 2;
  }

  /** 屏幕坐标 → 原图像素坐标 */
  toImage(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.ox) / this.scale,
      y: (clientY - r.top - this.oy) / this.scale,
    };
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.toImage(e.clientX, e.clientY);
    const before = this.scale;
    this.scale = clamp(this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.02, 12);
    // 以鼠标为锚点缩放
    const r = this.stage.getBoundingClientRect();
    this.ox = e.clientX - r.left - p.x * this.scale;
    this.oy = e.clientY - r.top - p.y * this.scale;
    if (before !== this.scale) this.render();
  }

  // ---- 渲染 --------------------------------------------------------------

  render() {
    if (!this.root || !this.baseImg) return;
    const ctx = this.vctx;
    ctx.save();
    ctx.fillStyle = "#0b0c0f";
    ctx.fillRect(0, 0, this.vw, this.vh);
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    const w = this.baseImg.naturalWidth;
    const h = this.baseImg.naturalHeight;

    if (this.mode === "mask") {
      // 仅遮罩：mask 本身就是灰度图，直接铺上去就是黑白效果
      ctx.imageSmoothingEnabled = this.scale < 1;
      ctx.drawImage(this.mask, 0, 0, w, h);
      // 描个边，不然全黑的图看不出边界在哪
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1 / this.scale;
      ctx.strokeRect(0, 0, w, h);
    } else {
      ctx.drawImage(this.baseImg, 0, 0);
      if (this.tintedDirty || !this.tinted) this.rebuildTinted();
      ctx.globalAlpha = MASK_ALPHA;
      ctx.drawImage(this.tinted, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /** 把灰度 mask 染成绿色。「颜色叠加」模式用，mask 变了才重算。 */
  rebuildTinted() {
    const w = this.mask.width;
    const h = this.mask.height;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true });

    // mask 是「不透明黑 / 不透明白」的灰度图，**alpha 恒为 255**。
    // 所以绝不能直接拿它做 source-in 的蒙版 —— 那样整块画布都有 alpha，
    // 结果是整张照片糊成一片绿，笔迹完全看不出来。
    // 正确做法：先把亮度搬到 alpha 通道上，再上色。
    cx.drawImage(this.mask, 0, 0);
    const id = cx.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = d[i]; // alpha = 灰度（涂过=255，没涂=0）
      d[i] = d[i + 1] = d[i + 2] = 255;
    }
    cx.putImageData(id, 0, 0);

    cx.globalCompositeOperation = "source-in";
    cx.fillStyle = MASK_COLOR;
    cx.fillRect(0, 0, w, h);
    this.tinted = c;
    this.tintedDirty = false;
  }

  // ---- 绘制 --------------------------------------------------------------

  /** 屏幕坐标 → mask 画布坐标 */
  toMask(clientX, clientY) {
    const p = this.toImage(clientX, clientY);
    const w = this.baseImg.naturalWidth;
    const h = this.baseImg.naturalHeight;
    return {
      x: (p.x / w) * this.mask.width,
      y: (p.y / h) * this.mask.height,
    };
  }

  onPointerDown(e) {
    if (e.target.closest?.(".lir-mask-bar")) return;
    this.stage.setPointerCapture(e.pointerId);

    // 右键：调笔刷（color 模式下右键取色那套不做，只留调大小）
    if (e.button === 2) {
      e.preventDefault();
      this.resizing = { x: e.clientX, size: this.brushSize };
      return;
    }
    // 中键 / 空格：平移
    if (e.button === 1 || this.spaceDown) {
      e.preventDefault();
      this.panning = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
      return;
    }
    if (e.button !== 0) return;

    this.drawing = true;
    this.emptyWarned = false;
    this.setHint(null);
    this.last = this.toMask(e.clientX, e.clientY);
    // 点一下也是一笔，画个点
    this.paintDot(this.last.x, this.last.y);
    this.render();
  }

  onPointerMove(e) {
    this.moveCursor(e);

    if (this.resizing) {
      const d = e.clientX - this.resizing.x;
      // 横向拖动改大小，跟 Goohaitools 一致；一步 1px 手感太细，放大 2 倍
      this.setBrushSize(clamp(this.resizing.size + d * 2, BRUSH_MIN, BRUSH_MAX));
      return;
    }
    if (this.panning) {
      this.ox = this.panning.ox + (e.clientX - this.panning.x);
      this.oy = this.panning.oy + (e.clientY - this.panning.y);
      this.render();
      return;
    }
    if (!this.drawing) return;

    const p = this.toMask(e.clientX, e.clientY);
    this.paintLine(this.last.x, this.last.y, p.x, p.y);
    this.last = p;
    this.render();
  }

  onPointerUp(e) {
    if (this.resizing) {
      this.resizing = null;
      return;
    }
    if (this.panning) {
      this.panning = null;
      return;
    }
    if (!this.drawing) return;
    this.drawing = false;
    this.endStroke();
  }

  endStroke() {
    if (!this.dirty) return;
    this.dirty = false;
    // 描边过程中不跑 flood fill（每帧都跑会卡），松手时补一次
    if (this.autoFill) {
      const cx = this.mask.getContext("2d", { willReadFrequently: true });
      const id = cx.getImageData(0, 0, this.mask.width, this.mask.height);
      if (fillEnclosedHoles(id.data, this.mask.width, this.mask.height) > 0) {
        cx.putImageData(id, 0, 0);
      }
    }
    this.tintedDirty = true;
    this.render();
  }

  setBrushSize(n) {
    this.brushSize = Math.round(n);
    if (this.sizeLabel) this.sizeLabel.textContent = this.brushSize + "px";
  }

  moveCursor(e) {
    if (!this.cursor) return;
    const r = this.stage.getBoundingClientRect();
    const d = this.brushSize * this.scale;
    this.cursor.style.display = "block";
    this.cursor.style.width = d + "px";
    this.cursor.style.height = d + "px";
    this.cursor.style.left = e.clientX - r.left - d / 2 + "px";
    this.cursor.style.top = e.clientY - r.top - d / 2 + "px";
  }

  /** 一笔画下去。半径按 mask 画布尺寸算，跟屏幕上的手感才一致。 */
  brushRadius() {
    const w = this.baseImg.naturalWidth;
    return (this.brushSize / 2 / this.scale) * (this.mask.width / w);
  }

  paintDot(x, y) {
    const cx = this.mask.getContext("2d");
    cx.fillStyle = this.tool === "eraser" ? "#000" : "#fff";
    cx.beginPath();
    cx.arc(x, y, this.brushRadius(), 0, Math.PI * 2);
    cx.fill();
    this.dirty = true;
    this.tintedDirty = true;
  }

  paintLine(x0, y0, x1, y1) {
    const cx = this.mask.getContext("2d");
    cx.strokeStyle = this.tool === "eraser" ? "#000" : "#fff";
    cx.lineWidth = this.brushRadius() * 2;
    cx.lineCap = "round";
    cx.lineJoin = "round";
    cx.beginPath();
    cx.moveTo(x0, y0);
    cx.lineTo(x1, y1);
    cx.stroke();
    this.dirty = true;
    this.tintedDirty = true;
  }

  // ---- 工具条 ------------------------------------------------------------

  onAction(act, btn) {
    switch (act) {
      case "brush":
        this.tool = "brush";
        this.syncToggle();
        break;
      case "eraser":
        this.tool = "eraser";
        this.syncToggle();
        break;
      case "mode-mask":
        this.mode = "mask";
        this.syncToggle();
        this.render();
        // 仅遮罩视图不画照片，空遮罩就是一片纯黑 —— 主动说一句，
        // 免得又被当成「编辑器坏了」。
        if (this.maskIsEmpty()) {
          this.setHint(
            "「仅遮罩」只显示灰度遮罩，不显示照片。现在还没涂任何区域，所以是全黑 —— 切回「颜色叠加」就能看到原图。",
            "warn"
          );
        } else {
          this.setHint(null);
        }
        break;
      case "mode-color":
        this.mode = "color";
        this.syncToggle();
        this.setHint(null);
        this.render();
        break;
      case "autofill":
        this.autoFill = !this.autoFill;
        this.syncToggle();
        break;
      case "invert": {
        const cx = this.mask.getContext("2d", { willReadFrequently: true });
        const id = cx.getImageData(0, 0, this.mask.width, this.mask.height);
        for (let i = 0; i < id.data.length; i += 4) {
          const v = 255 - id.data[i];
          id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        }
        cx.putImageData(id, 0, 0);
        this.tintedDirty = true;
        this.render();
        break;
      }
      case "clear": {
        const cx = this.mask.getContext("2d");
        cx.fillStyle = "#000";
        cx.fillRect(0, 0, this.mask.width, this.mask.height);
        this.tintedDirty = true;
        this.render();
        break;
      }
      case "cancel":
        this.close();
        break;
      case "save":
        this.save();
        break;
    }
  }

  syncToggle() {
    if (!this.root) return;
    const map = {
      brush: this.tool === "brush",
      eraser: this.tool === "eraser",
      "mode-mask": this.mode === "mask",
      "mode-color": this.mode === "color",
      autofill: this.autoFill,
    };
    for (const btn of this.root.querySelectorAll("[data-act]")) {
      const want = map[btn.dataset.act];
      if (want !== undefined) btn.setAttribute("aria-pressed", String(want));
    }
  }

  // ---- 保存 --------------------------------------------------------------

  /** 底部的提示条。传 null 恢复默认文案。 */
  setHint(text, tone) {
    if (!this.hint) return;
    this.hint.textContent = text || HINT_DEFAULT;
    this.hint.style.color =
      tone === "warn" ? "#f0b23a" : tone === "ok" ? "#3ddc97" : "";
  }

  /** 保存成功的绿色提示。放浮层外面，因为浮层这时候已经关掉了。 */
  toast(text) {
    const el = document.createElement("div");
    el.className = "lir-mask-toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 400);
    }, 2600);
  }

  /** mask 是不是一点都没涂。切到仅遮罩视图时用来判断要不要提示。 */
  maskIsEmpty() {
    if (!this.mask) return true;
    const cx = this.mask.getContext("2d", { willReadFrequently: true });
    return (
      countPainted(cx.getImageData(0, 0, this.mask.width, this.mask.height).data) === 0
    );
  }

  async save() {
    if (!this.baseImg) return;
    const btn = this.root?.querySelector('[data-act="save"]');

    // 一笔都没画就存，出来的必然是全黑遮罩 —— 后端 mask = 1 - alpha，
    // alpha 全 255 就是全 0。这个坑太容易踩，先拦一道。
    const cx0 = this.mask.getContext("2d", { willReadFrequently: true });
    const painted = countPainted(
      cx0.getImageData(0, 0, this.mask.width, this.mask.height).data
    );
    if (painted === 0 && !this.emptyWarned) {
      this.emptyWarned = true;
      this.setHint(
        "还没涂任何区域 —— 这样保存出来会是全黑遮罩。再点一次「保存遮罩」可以强制保存。",
        "warn"
      );
      return;
    }
    this.emptyWarned = false;

    if (btn) {
      btn.disabled = true;
      btn.textContent = "保存中…";
    }
    try {
      const value = await this.buildMaskedPng();
      const uploaded = await this.upload(value.blob, value.filename);
      const ref =
        (uploaded.subfolder ? uploaded.subfolder + "/" : "") +
        uploaded.name +
        " [input]";
      const total = this.mask.width * this.mask.height;
      const pct = ((painted / total) * 100).toFixed(1);
      this.onSave?.(ref);
      this.close();
      this.toast(`遮罩已保存（覆盖 ${pct}%）· 直接运行工作流即可拿到 MASK`);
    } catch (err) {
      console.error("[LoadImageRecursive] 保存遮罩失败：", err);
      this.setHint("保存失败：" + (err?.message || err), "warn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "保存遮罩";
      }
    }
  }

  /**
   * 合成成品：RGB 取原图，alpha 写 255 - mask。
   *
   * 注意最后一步不走 canvas.toBlob() —— 那会经过 premultiplied 位图，
   * 把 alpha=0 处的 RGB 抹成纯黑。改成用 ImageData 直接编码 PNG，
   * 详见文件顶部「PNG 编码」一节的说明。
   */
  async buildMaskedPng() {
    const w = this.baseImg.naturalWidth;
    const h = this.baseImg.naturalHeight;

    // 原图 RGB
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(this.baseImg, 0, 0, w, h);

    // mask 放大回原图尺寸
    const scaled = document.createElement("canvas");
    scaled.width = w;
    scaled.height = h;
    const sctx = scaled.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(this.mask, 0, 0, w, h);
    const md = sctx.getImageData(0, 0, w, h).data;

    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = 255 - md[i];
    }

    const filename = MASKED_PREFIX + Date.now() + ".png";
    const blob = await encodePng(w, h, d);
    return { blob, filename };
  }

  async upload(blob, filename) {
    const fd = new FormData();
    fd.append("image", blob, filename);
    fd.append("subfolder", CLIPSPACE_DIR);
    fd.append("type", "input");
    const res = await fetch("/upload/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error("upload failed: " + res.status);
    const data = await res.json();
    if (!data.name) throw new Error("upload response missing name");
    return data;
  }

  // ---- 键盘 --------------------------------------------------------------

  onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.code === "Space") {
      // 别让空格把页面滚了
      e.preventDefault();
      this.spaceDown = true;
      return;
    }
    if (e.key === "[") this.setBrushSize(clamp(this.brushSize - 4, BRUSH_MIN, BRUSH_MAX));
    if (e.key === "]") this.setBrushSize(clamp(this.brushSize + 4, BRUSH_MIN, BRUSH_MAX));
  };

  onKeyUp = (e) => {
    if (e.code === "Space") this.spaceDown = false;
  };
}

const editor = new MaskEditor();

// 调试用把手：控制台里能直接看遮罩状态，自动化测试也靠它断言染色结果。
// 只是个引用，不影响任何行为。
if (typeof window !== "undefined") window.__lirMaskEditor = editor;

// ---------------------------------------------------------------------------
// 挂到节点上
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "xiaowang.LoadImageRecursive.MaskEditor",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    // 右键菜单只在 prototype 上包一次。
    // 之前这段写在 onNodeCreated 里，每 new 一个节点就会把 getExtraMenuOptions
    // 再包一层 —— 开十个节点就链十层，菜单里跟着出现十个「编辑遮罩」。
    const onGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const result = onGetExtraMenuOptions?.apply(this, arguments);
      options.push(null, {
        content: "🎨 编辑遮罩",
        callback: () => {
          const w = this.widgets?.find((x) => x.name === "image");
          if (!w?.value) return;
          editor.open({
            value: w.value,
            onSave: (ref) => {
              w.value = ref;
              w.callback?.(ref);
              this.graph?.setDirtyCanvas(true, true);
            },
          });
        },
      });
      return result;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);

      const node = this;
      const imageWidget = node.widgets?.find((w) => w.name === "image");
      if (!imageWidget) return;

      // 已经有按钮就别加第二个（热重载时 onNodeCreated 会再跑一遍）
      if (node.widgets?.some((w) => w.name === "mask_edit")) return;

      node.addWidget(
        "button",
        "mask_edit",
        null,
        async () => {
          const value = imageWidget.value;
          if (!value) {
            console.warn("[LoadImageRecursive] 先选一张图再开遮罩");
            return;
          }
          await editor.open({
            value,
            onSave: (ref) => {
              // 保存完把新值写回 widget 并触发回调 —— 跟用户在下拉里点了
              // 这一项等价，folderFilter 的同步逻辑会自己接上。
              imageWidget.value = ref;
              imageWidget.callback?.(ref);
              node.graph?.setDirtyCanvas(true, true);
            },
          });
        },
        { serialize: false }
      );
    };
  },
});
