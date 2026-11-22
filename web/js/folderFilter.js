/**
 * 「加载图片(含子目录)」的前端联动。
 *
 * 后端在 image 前面多塞了一个 folder widget（候选值就是 input 下所有子目录）。
 * 这里把两者接起来：
 *
 *   folder 变  → image.options.values 收窄成该目录下的文件
 *                 若当前选中的图不在新目录里，自动选中第一张，预览跟着切
 *   image  变  → folder 自动跳到这张图所在的目录
 *
 * 第二条能关掉：【目录】控件自己的左端有个小锁图标，点一下即锁。锁上之后
 * 两件事同时发生 ——
 *   1. 【目录】的 ◀ ▶ 箭头失效（变禁用灰、点了不换值）。这是为了选文件时
 *      手滑碰到控件边缘，目录被顺手带跑。
 *   2. 「图片变 → 目录跳」这条线切断，目录钉在原地，图片怎么换都不带动它。
 * 但下拉菜单选目录、书签跳转这些**用户主动操作照常放行** —— 锁是防误触，
 * 不是把自己锁死。
 * 锁定状态存在 node.properties 里，随工作流保存。
 *
 * 另外管一件事：**列表的刷新**。
 * ComfyUI 的 INPUT_TYPES 只在建节点时取一次，所以之后往 input 里新建文件夹、
 * 拖图进去、或者用上传按钮传图，下拉里都看不到。三条路各自触发一次重建：
 *
 *   1. refreshComboInNodes 扩展钩子 —— ComfyUI 每次重建 combo 列表都会调，
 *      而且它是直接 `options.values = 后端新列表`，会把我们的过滤冲掉，必须补回来
 *   2. 上传按钮的 callback —— 传完图延时重建
 *   3. 节点右键菜单「刷新图片列表」—— 前两条都没覆盖到时的兜底
 *
 * 之所以能直接换掉 options.values，是因为 ComfyUI 那套 Vue 下拉会跟着重渲染。
 * 实测：赋值 + setDirtyCanvas 之后，下拉列表当场就变成新列表。
 * 注意别用 __v_isReactive 做判断 —— 节点已入图时 options/values 带这个标记，
 * 未入图（例如 LiteGraph.createNode 出来还没 add 的裸节点）时没有，
 * 两种情况功能都正常。
 *
 * 另外还替 maskEditor.js 兜一件事：遮罩成品存在 clipspace 下，后端扫不到，
 * 所以那个值由这里负责塞进候选列表（见 keepMaskValuesVisible）。
 */

import { app } from "../../../scripts/app.js";

const ALL = "(全部)";
// 必须跟后端 __init__.py 里的 ROOT_FOLDER 逐字一致 —— 改文案要两边一起改
const ROOT = "(根目录)";
const NODE_NAME = "LoadImageRecursive";
const OBJECT_INFO_URL = "/object_info/" + NODE_NAME;
// 遮罩编辑器（maskEditor.js）存下来的成品。后端扫描时把 clipspace 剪掉了，
// 所以这个值永远不会出现在候选列表里 —— 得由前端补进去，否则保存完下拉是空的。
const CLIPSPACE_PREFIX = "clipspace/";

// ===========================================================================
// 外观：把【目录】做得跟【图像】一眼能分开
// ===========================================================================
//
// 用户跑的是经典 canvas 渲染（设置里没开 Nodes 2.0），所以 widget 是
// `drawWidget(ctx, {width, showText})` 一笔一笔画出来的，直接覆写**实例**上的
// 方法就能改外观，不碰 DOM、不碰 CSS，也就不会跟渲染层打架。
//
// 两条区分线：
//   1. 描边和底色换成青色系（锁定后转琥珀）—— 扫一眼就知道哪个是目录
//   2. 左端画一个开锁/解锁的小图标，点它就能把目录钉住 —— 位置、配色、状态一体
//
// 图标一律用 canvas path 画，**绝不能往 label 里塞 emoji**：
// 原生 drawTruncatingText 在文字装不下时按像素宽度硬切字符串，会把 emoji 的
// 代理对（📁 = \ud83d\udcc1 两个 UTF-16 单元）从中间切开，渲染成乱码方块。
// 而「◀ ▶ 切换目录」恰好会让右侧值变长，正好踩中截断分支 —— 这就是之前
// 一按箭头图标就变乱码的根因。显示名保持纯文字，图标自己画。
//
// 底色要跟着主题走：ComfyUI 有深浅两套主题，硬编码深色在浅色主题下会糊成一团。
// 判断办法是读 litegraph 的原生 widget 底色，算一下亮度。

const WIDGET_MARGIN_FALLBACK = 15;

// --- 锁图标的几何 ----------------------------------------------------------
//
// 原生【目录】控件的左右两端各有一个 ◀ ▶，位置写死在 BaseSteppedWidget 里：
//
//   margin(15) + arrowMargin(6) = 21          ← 左箭头尖端
//   再往右 arrowWidth(10)       = 31          ← 左箭头底边
//   文字从 margin*2 + leftPadding(5) = 35     ← 起笔
//   右箭头是镜像：width-31 ~ width-21
//
// 要把锁图标塞进最左边，左箭头和文字都得往右让，让出来的量叫 ARROW_SHIFT：
//
//   锁图标   中心 22，标称尺寸 12 → 锁体 x ∈ 17 ~ 27
//   左箭头   29 ~ 39    （原生 21~31，右移 8）
//   文字     43 起笔    （原生 35，靠 leftPadding 由 5 抬到 13）
//   右箭头   不动
//
// 一条不能破的红线：**左箭头不能越过 x=40**。原生 ComboWidget.onClick 的判定
// 是「节点内 x<40 就算点了左箭头」，箭头要是挪到 40 右边，就会变成
// 「看得见却点不着、点了反而弹出下拉菜单」。39 正好卡在红线里 —— 也就是说
// ARROW_SHIFT 最多只能取 9。
const ARROW_SHIFT = 8;
const LOCK_ICON_DX = 7; // 图标中心相对 widget 左边缘的偏移 → 22
const LOCK_ICON_SIZE = 12; // 标称尺寸；实际按控件高度收，最高就是这个值
const LOCK_HIT_DX = 13; // 点击热区右边界（相对左边缘）→ 28，不侵占箭头

/** 顺着原型链找属性描述符（widget 的具体类层层继承，方法不一定在第一层）。 */
function findProtoDescriptor(object, name) {
  let proto = Object.getPrototypeOf(object);
  while (proto && proto !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (desc) return desc;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/** "#222" / "#222222" 这类颜色是不是偏暗。 */
function _isDarkColor(color, fallback = true) {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(color || "").trim());
  if (!match) return fallback;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

/** 目录 widget 的配色：未锁 = 青绿，锁定 = 琥珀。 */
function folderAccent(locked) {
  return locked
    ? { stroke: "#eaa93e", fillDark: "#3b2a12", fillLight: "#fbeed1" }
    : { stroke: "#3fc4b4", fillDark: "#123a36", fillLight: "#d9f2ee" };
}

/**
 * 在 widget 左端画一个开锁 / 闭合锁的小图标。
 *
 * 不用 emoji，全部走 canvas path —— 避开截断切碎代理对的坑，也顺手免了
 * 字体渲染出来的大小、基线不一致问题。
 *
 * @param ctx     canvas 2d context
 * @param cx,cy   图标中心
 * @param size    图标高度（约等于锁体高度）
 * @param locked  true 画闭合锁（锁梁扣下），false 画开锁（锁梁弹起偏右）
 * @param color   线条颜色
 */
function drawLockGlyph(ctx, cx, cy, size, locked, color) {
  const bodyH = size * 0.52;
  const bodyW = size * 0.82;
  const shackleR = size * 0.28;
  // 让「锁梁顶 → 锁体底」这条整体在 cy 上居中
  const bodyTop = cy + (shackleR - bodyH) / 2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.4, size * 0.13);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 锁梁先画、锁体后画 —— 这样两根竖腿的下半截会被锁体实心盖住，
  // 接缝处不会露出线头。
  //
  // 闭合：锁梁居中扣下，两条腿正对锁体左右。
  // 开锁：整体抬起并向右偏，"右腿"落到锁体外面悬着 —— 一眼看出是开着的。
  const offsetX = locked ? 0 : size * 0.2;
  const offsetY = locked ? 0 : -size * 0.08;
  const shackleCx = cx + offsetX;
  const shackleTop = bodyTop + offsetY;
  const legBottom = shackleTop + size * 0.26;

  ctx.beginPath();
  ctx.moveTo(shackleCx - shackleR, legBottom); // 左腿，从锁体里往下起笔
  ctx.lineTo(shackleCx - shackleR, shackleTop);
  ctx.arc(shackleCx, shackleTop, shackleR, Math.PI, 0, false); // 上半圈
  ctx.lineTo(shackleCx + shackleR, legBottom); // 右腿
  ctx.stroke();

  // 锁体：实心圆角矩形，比线框在小尺寸下清楚得多
  ctx.beginPath();
  ctx.roundRect(cx - bodyW / 2, bodyTop, bodyW, bodyH, [size * 0.14]);
  ctx.fill();

  ctx.restore();
}

/**
 * 给【目录】下拉上色 + 塞一个锁图标进去。
 *
 * 除了配色，这里还接管了三处原生绘制/交互，都是为了给图标腾位置：
 *   drawWidget         —— 后置画锁图标
 *   drawArrowButtons   —— 左箭头右移，右箭头不动
 *   drawTruncatingText —— 文字起笔右移，别压到箭头上
 *   onClick            —— 最左边那一小条拦下来当"切锁"按钮
 *
 * @param widget     folder combo widget
 * @param getLocked  () => boolean，读当前锁定状态
 * @param toggleLock () => void，切换锁定
 */
function styleFolderWidget(widget, getLocked, toggleLock) {
  // 方法/访问器都可能定义在更上层原型，得顺着链找，不能只看第一层
  const drawDesc = findProtoDescriptor(widget, "drawWidget");
  const baseDraw = typeof drawDesc?.value === "function" ? drawDesc.value : null;
  if (!baseDraw) return;

  const arrowDesc = findProtoDescriptor(widget, "drawArrowButtons");
  const baseArrow = typeof arrowDesc?.value === "function" ? arrowDesc.value : null;

  const textDesc = findProtoDescriptor(widget, "drawTruncatingText");
  const baseText = typeof textDesc?.value === "function" ? textDesc.value : null;

  const clickDesc = findProtoDescriptor(widget, "onClick");
  const baseClick = typeof clickDesc?.value === "function" ? clickDesc.value : null;

  // 先扣住原生底色 getter，之后靠它判断深浅主题。
  // 用 call 而不是 bind —— 后者会被 Registry 的静态扫描误判成网络调用，
  // 1.0.7 因此被打上 Flagged，这里换成闭包转发，语义不变。
  const bgDesc = findProtoDescriptor(widget, "background_color");
  const nativeGet = typeof bgDesc?.get === "function" ? bgDesc.get : null;
  const nativeBackground = nativeGet ? () => nativeGet.call(widget) : null;

  const marginOf = () => Number(widget.constructor?.margin) || WIDGET_MARGIN_FALLBACK;

  // 底色：原生 drawWidgetShape 读 this.background_color，换个 getter 就行。
  // 类上的访问器默认 configurable，所以实例层面能盖掉。
  Object.defineProperty(widget, "background_color", {
    configurable: true,
    get() {
      const accent = folderAccent(getLocked());
      const base = nativeBackground ? nativeBackground() : "#222222";
      return _isDarkColor(base) ? accent.fillDark : accent.fillLight;
    },
  });

  // 描边：drawWidgetShape 调 this.getOutlineColor()，同样实例级覆盖
  widget.getOutlineColor = () => folderAccent(getLocked()).stroke;

  // --- 箭头：整段接管，只把左箭头右移 -------------------------------------
  //
  // 原生版本自己会 beginPath + 按 canDecrement/canIncrement 设填充色，
  // 所以不能"包一层再微调"，只能照着抄一遍改坐标。
  if (baseArrow) {
    widget.drawArrowButtons = function (ctx, width) {
      const { height, text_color: textColor, disabledTextColor, y } = this;
      const margin = marginOf();
      const arrowMargin = Number(this.constructor?.arrowMargin) || 6;
      const arrowWidth = Number(this.constructor?.arrowWidth) || 10;

      const leftNear = margin + arrowMargin + ARROW_SHIFT; // 29
      const leftFar = leftNear + arrowWidth; // 39
      const rightNear = margin + arrowMargin; // 21（右箭头不动）
      const rightFar = rightNear + arrowWidth; // 31

      // 左箭头：尖端朝左
      ctx.fillStyle = this.canDecrement() ? textColor : disabledTextColor;
      ctx.beginPath();
      ctx.moveTo(leftFar, y + 5);
      ctx.lineTo(leftNear, y + height * 0.5);
      ctx.lineTo(leftFar, y + height - 5);
      ctx.fill();

      // 右箭头：尖端朝右，按 width 镜像，位置保持原生
      ctx.fillStyle = this.canIncrement() ? textColor : disabledTextColor;
      ctx.beginPath();
      ctx.moveTo(width - rightFar, y + 5);
      ctx.lineTo(width - rightNear, y + height * 0.5);
      ctx.lineTo(width - rightFar, y + height - 5);
      ctx.fill();
    };
  }

  // --- 文字：起笔右移 8px，避开挪过来的左箭头 -----------------------------
  //
  // 原生签名是单个对象 drawTruncatingText({ctx, width, leftPadding=5, rightPadding=20})，
  // 文字起笔 = margin*2 + leftPadding（默认 30+5 = 35）。这里把 leftPadding
  // 抬到 13（→ 起笔 x=43），正好接在左箭头底边（39）后面。
  // 其余截断逻辑一概不动 —— 那套逻辑本身没毛病，之前出乱码是因为
  // label 里塞了 emoji，现在 label 已经是纯文字了。
  if (baseText) {
    widget.drawTruncatingText = function (opts) {
      const next = Object.assign({}, opts);
      if (next.leftPadding === undefined) next.leftPadding = 5 + ARROW_SHIFT;
      return baseText.call(this, next);
    };
  }

  // --- 点击：最左边一条拦成锁按钮 -----------------------------------------
  //
  // 原生 onClick 的分流是「x<40 → 左箭头 / x>width-40 → 右箭头 / 其余 → 下拉」。
  // 锁图标在 17~27，本来会落进"左箭头"热区，所以这里抢在它前面拦下来。
  // 阈值取 margin + 13 = 28，正好卡在锁图标右缘和左箭头左缘（29）之间。
  if (baseClick) {
    widget.onClick = function (opts) {
      const event = opts?.e;
      const node = opts?.node;
      if (event && node) {
        const localX = Number(event.canvasX) - Number(node.pos?.[0] ?? 0);
        // 下界留 4px 容差：圆角外那一小圈也算点到了图标，手感更松快。
        // 但别一路放到负坐标 —— 那就成"点节点左边框也切锁"了。
        if (localX >= marginOf() - 4 && localX < marginOf() + LOCK_HIT_DX) {
          // 吃掉这次点击，顺手清掉"上一次点击"的时间戳 ——
          // 不清的话画布可能把它和随后的点击拼成双击，把节点拖起来。
          if (opts.canvas) opts.canvas.last_mouseclick = 0;
          toggleLock();
          return;
        }
      }
      return baseClick.apply(this, arguments);
    };
  }

  // --- 最后一道：图标本身 ------------------------------------------------
  //
  // 原生 drawWidget 已经把底色、描边、箭头、文字全画完了，图标只能后置补，
  // 而且要自己管 fillStyle —— 原生最后有 Object.assign 还原，靠不住。
  widget.drawWidget = function (ctx, opts) {
    baseDraw.call(this, ctx, opts);
    if (!ctx || typeof ctx.roundRect !== "function") return;
    // 极窄/hideText 时原生只画一个纯色条，没有箭头也没有文字 ——
    // 这时候再往上叠锁图标只会变成一个挤在边上的小疙瘩。
    if (opts?.showText === false) return;

    const height = Number(this.height) || 0;
    if (!(height > 0)) return;

    const margin = marginOf();
    const locked = !!getLocked();
    const accent = folderAccent(locked);

    // 未锁：用主题正文色，深浅主题下都不缺对比度，也不抢数值的视线。
    // 锁定：琥珀 —— 深色底直接用亮琥珀，浅色底的琥珀偏淡，换成压深的同色，
    // 否则在米色底上几乎看不见。
    const onDark = _isDarkColor(this.background_color);
    const color = locked ? (onDark ? accent.stroke : "#a06a10") : this.text_color;

    drawLockGlyph(
      ctx,
      margin + LOCK_ICON_DX,
      this.y + height * 0.5,
      // 控件矮的时候按比例缩，最高不超过标称尺寸（12 → 锁体 17~27，正好让开箭头）
      Math.min(height * 0.62, LOCK_ICON_SIZE),
      locked,
      color,
    );
  };
}

/**
 * 让 combo 的 ◀ ▶ 箭头首尾相接，并且可以选择性地「让箭头彻底失效」。
 *
 * 原生 ComboWidget 的规则是「走到头就停」：
 *
 *   canIncrement()   -> currentIndex !== values.length - 1
 *   incrementValue() -> clamp(currentIndex + 1, 0, values.length - 1)
 *
 * 所以停在最后一张时右箭头会变灰、点了没反应，只能一路反向绕回去。
 *
 * 这里在**实例**上覆写这四个方法（不是改原型），所以只影响本节点的两个下拉，
 * 原生「加载图像」「CLIP 名称」那些节点保持原样。
 *
 * 取值一律走 options.values —— 它可能已被 applyFilter() 收窄过，
 * 所以循环范围就是「当前目录里能看到的那些图」，不会绕到别的目录去。
 *
 * options.canStep
 *   给【目录】用：返回 false 时这俩箭头等于被拔掉。
 *   原生 drawArrowButtons 是拿 canDecrement()/canIncrement() 的返回值决定
 *   画什么颜色的，所以让它返回 false 一举两得 —— 箭头自动变禁用灰，
 *   点了也不换值，不需要再多画一套「看起来禁用、其实只是不响应」的假象。
 *   这不影响下拉菜单里手选目录，也不影响书签跳转：那些都走 setValue 直通。
 */
function makeCyclicCombo(widget, widgetOptions = {}) {
  if (typeof widget.setValue !== "function") return;

  const canStep = typeof widgetOptions.canStep === "function" ? widgetOptions.canStep : null;

  const valuesOf = () => {
    const values = widget.options?.values;
    return Array.isArray(values) ? values : [];
  };

  const stepBy = (delta) => (options) => {
    const values = valuesOf();
    if (values.length < 2) return;

    // 原生 setValue 内部要拿 node 做 onWidgetChanged、拿 canvas 做重绘，
    // 外面有人无参调用 incrementValue() 会当场炸在 setValue 里。这里先挡掉。
    if (!options?.node) return;

    // 跟原生实现一致：吃掉这次点击，免得画布把这一下和下一次拼成双击。
    // 放在锁定判断**前面** —— 点了禁用箭头也得把这一下吃掉，
    // 否则点两下死箭头会被当成双击节点、把节点拖起来。
    if (options.canvas) options.canvas.last_mouseclick = 0;

    // 锁定期间箭头是死的。canIncrement/canDecrement 已经返回 false，
    // 正常画不出来可点的箭头；这里再挡一道，防的是键盘或外部代码直接调。
    if (canStep && !canStep()) return;

    let index = values.indexOf(widget.value);
    if (index === -1) {
      // 当前值不在列表里（刚切过目录，或那张图被删了）：从对应那一端进来
      index = delta > 0 ? -1 : values.length;
    }
    const next = (index + delta + values.length) % values.length;

    // 这里**不**打任何"这是箭头点的"标记 —— 箭头换图和下拉选图走的是同一条
    // setValue → callback 路。上一版给箭头路径打了标记、让回调跳过同步，
    // 结果锁在「箭头翻图」这条最常用路径上完全失效，用户一试就发现没区别。
    // 现在是否跟随只由 onNodeCreated 里那一个 locked 决定，一处说了算。
    //
    // 「想一路翻全部、目录别跟着跳」怎么办？点【目录】左端的小锁 ——
    // 锁上之后目录不光不跟随，连它自己的箭头也一起停用，翻页时手滑也带不跑。
    widget.setValue(values[next], options);
  };

  widget.canIncrement = () => valuesOf().length > 1 && (!canStep || canStep());
  widget.canDecrement = () => valuesOf().length > 1 && (!canStep || canStep());
  widget.incrementValue = stepBy(1);
  widget.decrementValue = stepBy(-1);
}

app.registerExtension({
  name: "xiaowang.LoadImageRecursive.FolderFilter",

  /**
   * ComfyUI 官方扩展钩子：combo 列表刚被整体重建完。
   * 此时 options.values 已经换成后端的最新列表，我们的过滤没了 —— 补一次。
   */
  async refreshComboInNodes() {
    const nodes = app.graph?._nodes || app.graph?.nodes || [];
    for (const node of nodes) {
      if (node?.type === NODE_NAME) {
        await node._folderFilterReload?.();
      }
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);

      const node = this;
      const folderWidget = this.widgets?.find((w) => w.name === "folder");
      const imageWidget = this.widgets?.find((w) => w.name === "image");
      if (!folderWidget || !imageWidget) return;

      // 锁定状态先声明 —— 下面给【目录】装箭头时要读它
      let locked = false;

      // 两个下拉都改成首尾相接：目录走到底接回「(全部)」，图片走到底接回第一张。
      //
      // 【目录】那颗锁管的就是左右箭头：锁定期间 canIncrement/canDecrement 恒为
      // false，箭头自动画成禁用灰、点了也不换值 —— 选文件时手滑碰到控件边缘，
      // 目录不会跟着跑掉。图片那个下拉不受影响，照常首尾相接。
      makeCyclicCombo(folderWidget, { canStep: () => !locked });
      makeCyclicCombo(imageWidget);

      // ---- 外观区分 + 锁定开关 ----------------------------------------------

      // 显示名改中文。改的是 label 不是 name —— 各处都靠 name 找 widget，
      // 后端拿值也是按 name 取，label 纯装饰。
      //
      // 一个字都别往这儿加 emoji：原生文字截断按像素宽度切字符串，
      // 会把 emoji 的代理对（📁 = \ud83d\udcc1）从中间切开、渲染成乱码方块。
      // 之前「一按 ◀ ▶ 小图标就变乱码」就是这么来的 —— 箭头换值让右侧数值
      // 变长，正好踩中截断分支。图标只能画，不能塞进文字。
      folderWidget.label = "目录";
      imageWidget.label = "图像";

      // 锁管两件事：
      //   1. 【目录】的 ◀ ▶ 失效（防误触：选文件时手滑碰到控件边缘，目录不会跑）
      //   2. 「图片变 → 目录跳」这条自动同步切断，目录钉在原地
      // 但**不拦**用户主动选目录：下拉菜单、书签跳转、右键刷新照常工作
      // —— 否则那不叫锁，叫禁用，连自己都改不了目录了。
      //
      // 状态存在 node.properties 里：那是按名字存的字典，跟 widgets_values 的
      // 位置索引无关，加一个字段不会让老工作流的参数错位。存下来的好处是
      // 「锁着存盘，打开还是锁着的」—— 不然一刷页面锁就没了，等于白锁。
      const LOCK_PROP = "lir_folder_locked";
      const setLocked = (next, persist = true) => {
        locked = !!next;
        // 给 lirExtras 的菜单读，两个扩展之间只靠这个字段通信
        node._lirFolderLocked = locked;
        if (persist) {
          node.properties ??= {};
          node.properties[LOCK_PROP] = locked;
        }
        app.graph?.setDirtyCanvas(true, true);
      };

      // 锁图标直接画在【目录】控件自己的左端，点它就切 ——
      // 不再额外占一行按钮，节点因此矮了一行，也跟目录绑成了一体。
      styleFolderWidget(folderWidget, () => locked, () => setLocked(!locked));

      // 初始 false 且不落盘 —— 否则会抢在 configure 恢复之前把工作流里
      // 存着的 true 覆盖掉
      setLocked(false, false);

      // 右键菜单是备选入口 —— 图标只有十几个像素，节点缩小时不好点，
      // 菜单里再给一条稳妥的。同时暴露给 lirExtras 用。
      this._lirSetFolderLock = setLocked;
      this._lirIsFolderLocked = () => locked;

      // 从工作流恢复。configure 在 onNodeCreated 之后跑，这里的读取由
      // onConfigure 的 setTimeout 负责（见文件末尾），属性和值都已就位。
      this._lirRestoreFolderLock = () => {
        const saved = this.properties?.[LOCK_PROP];
        if (typeof saved === "boolean" && saved !== locked) setLocked(saved, false);
      };

      // 后端给的完整候选列表。之后 imageWidget.options.values 会被我们改来改去，
      // 所以单独存一份全集当过滤源。
      const known = new Set();
      const all = [];

      // 只在建节点时播种一次。之后全集的权威来源是 reloadFromServer() ——
      // 千万不要在 applyFilter() 里反过来从 options.values 里"学习"：
      // 那时 options.values 可能是过滤后的子集，也可能是重建过程中的旧列表，
      // 会把已经删掉的文件学回来。
      const seedFromWidget = () => {
        const current = imageWidget.options?.values;
        if (!Array.isArray(current)) return;
        for (const value of current) {
          if (!known.has(value)) {
            known.add(value);
            all.push(value);
          }
        }
        all.sort();
      };
      seedFromWidget();

      const dirOf = (value) => {
        if (typeof value !== "string") return null;
        const slash = value.lastIndexOf("/");
        return slash === -1 ? ROOT : value.slice(0, slash);
      };

      const applyFilter = () => {
        const folder = folderWidget.value;
        if (!folder || folder === ALL) {
          imageWidget.options.values = all.slice();
        } else if (folder === ROOT) {
          // 根目录 = 路径里不带斜杠的那些。不用 dirOf 是因为这里要的是
          // 「这一个目录的文件」，而 dirOf 是反过来的「这个文件属于哪个目录」。
          imageWidget.options.values = all.filter((v) => !v.includes("/"));
        } else {
          // 只列「本级」的图片，不往下带子目录 —— 选 Ultra 就只看
          // ultra/ 直下的图，ultra/ultraman 里的要走 ultra/ultraman 那一项。
          // （旧版是 startsWith(folder + "/")，会把孙目录全捞进来，
          //   目录一多层就分不了类。）
          imageWidget.options.values = all.filter((v) => {
            const slash = v.lastIndexOf("/");
            return slash !== -1 && v.slice(0, slash) === folder;
          });
        }
        app.graph?.setDirtyCanvas(true, true);
      };

      /**
       * 切目录之后，把选中的那张图也一起带过去。
       *
       * 为什么必须自己动手：画布上那张预览图不是靠 options.values 驱动的，
       * 而是 image widget 自己的 callback —— 前端在 useImageUploadWidget 里
       * 给它挂了一个回调，负责 `node.imgs = undefined`、
       * `nodeOutputStore.setNodeOutputs(node, value)`、再重绘。
       * 只改候选列表不会触发它，所以预览会一直停在上一张图上。
       *
       * 这里的写法（改 value → 调 callback → setDirtyCanvas）跟 ComfyUI 自己
       * 「程序化改图片值」用的那套一模一样（见 clearDeletedAssetWidgetValues），
       * 效果等价于用户自己在下拉里点了那张图。
       */
      const followFolder = () => {
        const values = imageWidget.options?.values || [];
        if (!values.length) return;
        // 当前这张图还在新列表里就不动它
        // 典型场景：从某个子目录切回「全部」，原图仍然有效
        if (values.includes(imageWidget.value)) return;

        const next = values[0];
        imageWidget.value = next;
        // 注意：这个回调不读参数，只读 widget.value，所以必须先赋值再调
        imageWidget.callback?.(next);
        app.graph?.setDirtyCanvas(true, true);
      };

      /**
       * 位置回填的自愈：如果这个节点是在「还没有 folder widget」的版本下保存的，
       * widgets_values 只有一项，加载时会被塞进排在最前面的 folder。
       * 判据很简单 —— folder 的合法值只有后端给的那几个目录名，图片路径不在其中。
       */
      const healMisplacedValue = () => {
        const value = folderWidget.value;
        if (!value || folderWidget.options?.values?.includes(value)) return;
        folderWidget.value = ALL;
        if (!imageWidget.value) imageWidget.value = value;
      };

      const syncFolderFromImage = () => {
        // 锁定中：目录钉死，图片怎么换都不跟着跳。
        // 这一步只跳过「回填目录」，applyFilter 照跑 —— 列表得跟目录对上。
        if (!locked) {
          const dir = dirOf(imageWidget.value);
          // 算出来的目录名必须真的在候选列表里才回填。
          // 否则（图片在根目录、或 image 值本身是脏数据）会把一个非法目录名
          // 写进 folder —— 自愈逻辑刚清掉它，这里又写回去。
          if (
            dir &&
            dir !== folderWidget.value &&
            folderWidget.options?.values?.includes(dir)
          ) {
            folderWidget.value = dir;
          }
        }
        applyFilter();
      };

      // ---- 重建列表 ---------------------------------------------------------

      let reloading = false;
      let lastUnknown = null;

      /**
       * 直接问后端要一份最新的候选列表，然后整表重建。
       * 走 /object_info 而不是自己扫目录，是为了跟 INPUT_TYPES 用同一套逻辑 ——
       * 新建的文件夹、删掉的文件、改过的名字，一次全部对齐。
       */
      const reloadFromServer = async () => {
        if (reloading) return;
        reloading = true;
        try {
          const res = await fetch(OBJECT_INFO_URL);
          if (!res.ok) return;
          const info = await res.json();
          const required = info?.[NODE_NAME]?.input?.required;
          const folders = required?.folder?.[0];
          const files = required?.image?.[0];

          // 刷新列表不该动用户选的目录，先记下来
          const wanted = folderWidget.value;

          if (Array.isArray(folders)) {
            folderWidget.options.values = folders.slice();
          }
          if (Array.isArray(files)) {
            known.clear();
            all.length = 0;
            for (const value of files) {
              known.add(value);
              all.push(value);
            }
            all.sort();
          }

          // 老工作流回填进来的脏值（folder 里塞的是图片路径）就地修掉
          healMisplacedValue();

          // 原来选的目录还在就保留，被删掉了才退回「全部」。
          // 注意这里**不能**调 syncFolderFromImage() —— 那是「图片 → 目录」的
          // 反向同步，会把用户刚选的目录拉回到当前图片所在的目录去。
          const legal = folderWidget.options?.values || [];
          if (legal.includes(wanted)) folderWidget.value = wanted;

          lastUnknown = null;
          applyFilter();
          // 后端列表重建会把 clipspace 的成品冲掉，这里补回来
          keepMaskValuesVisible();
        } catch (err) {
          console.warn("[LoadImageRecursive] 刷新图片列表失败：", err);
        } finally {
          reloading = false;
        }
      };
      this._folderFilterReload = reloadFromServer;

      /**
       * 当前值不在已知集合里 —— 典型场景是用上传按钮传了张新图。
       * 同一個值只触发一次，免得反复拉。
       */
      const noteUnknownValue = () => {
        const value = imageWidget.value;
        if (typeof value !== "string" || !value || known.has(value)) {
          lastUnknown = null;
          return;
        }
        if (value === lastUnknown) return;
        lastUnknown = value;
        reloadFromServer();
      };

      /**
       * 遮罩成品要能在下拉里看见。
       *
       * 后端有意跳过 clipspace（那是个临时文件堆），所以保存完遮罩之后
       * image widget 指着 `clipspace/clipspace-painted-masked-xxx.png [input]`，
       * 而候选列表里没有这一项 —— 下拉会显示成空白，用户以为自己存失败了。
       *
       * 这里补两处：全集 all（保证 reload / applyFilter 之后还在），
       * 和当前正在显示的 options.values（当前目录被过滤过，可能正好没含它）。
       *
       * 只认 clipspace/ 前缀，别把别的脏值也学进来。
       */
      const keepMaskValuesVisible = () => {
        const value = imageWidget.value;
        if (typeof value !== "string" || !value.startsWith(CLIPSPACE_PREFIX)) return;
        if (!known.has(value)) {
          known.add(value);
          all.push(value);
          all.sort();
        }
        const current = imageWidget.options?.values;
        if (Array.isArray(current) && !current.includes(value)) {
          current.unshift(value);
        }
      };

      // ---- 回调挂钩 ---------------------------------------------------------

      const prevFolderCallback = folderWidget.callback;
      folderWidget.callback = function (value, ...rest) {
        const result = prevFolderCallback?.apply(this, [value, ...rest]);
        applyFilter();
        followFolder();
        return result ?? value;
      };

      const prevImageCallback = imageWidget.callback;
      imageWidget.callback = function (value, ...rest) {
        const result = prevImageCallback?.apply(this, [value, ...rest]);
        // 无论图是下拉选的、箭头翻的还是上传来的，都走同一条同步。
        // 「要不要真的跟着跳」由 syncFolderFromImage 里的 locked 决定 ——
        // 判定只留一处，箭头路径不许再私自绕过去（上一版的 bug 就出在这：
        // 箭头路径靠 __cyclicStepping 跳过同步，导致锁与不锁毫无区别）。
        //
        // 唯一的例外是 lirExtras 的「方向过滤」：那是在维持一个临时视图，
        // 程序自己把图片切到筛选结果的第一张，这时候目录不能跟着跑、
        // 列表也不能被 applyFilter 重放冲掉。它置 __lirSkipFolderSync 表明
        // 「这次改图不是用户在挑图」。
        if (!imageWidget.__lirSkipFolderSync) syncFolderFromImage();
        noteUnknownValue();
        keepMaskValuesVisible();
        return result ?? value;
      };

      // 上传按钮（ComfyUI 用 image_upload 注入的独立 widget）。
      // 上传是异步的，值要过一会儿才落下来，所以延时重建。
      const uploadWidget = this.widgets?.find((w) => w.name === "upload");
      if (uploadWidget) {
        const prevUploadCallback = uploadWidget.callback;
        uploadWidget.callback = function (...args) {
          const result = prevUploadCallback?.apply(this, args);
          setTimeout(() => reloadFromServer(), 800);
          return result;
        };
      }

      this._folderFilterSync = () => {
        healMisplacedValue();
        syncFolderFromImage();
        noteUnknownValue();
        keepMaskValuesVisible();
      };

      this._folderFilterSync();
    };

    // 从工作流加载时 configure() 直接写值，不会触发 callback，
    // 所以这里补一次同步，让目录下拉对上已保存的那张图。
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(() => {
        // 高度自愈：老工作流存下来的节点 size 是按当年的 widget 行数算的，
        // 如果之后的版本增减过 widget 行，configure 恢复旧 size 就会把某一行
        // 裁到框外。这里只在"真的装不下"时补高 —— 只按 widget 行的底边算，
        // 不用 computeSize（它会算进预览图高度，容易把用户手动调好的尺寸反复撑大）。
        //
        // 注意只补不缩：节点下半截是预览图的地盘，把高度往 bottom+8 收会连预览
        // 一起压掉。多出来的空白留给用户自己拉。
        try {
          let bottom = 0;
          for (const w of this.widgets || []) {
            if (w?.hidden) continue;
            const h = Number(w?.height) || 0;
            const y = Number(w?.y) || 0;
            if (y + h > bottom) bottom = y + h;
          }
          if (bottom > 0 && (this.size?.[1] ?? 0) < bottom + 8) {
            this.setSize?.([this.size[0], bottom + 8]);
            app.graph?.setDirtyCanvas(true, true);
          }
        } catch (err) {
          console.warn("[LoadImageRecursive] 校正节点高度失败：", err);
        }
        // 先恢复锁定状态，再同步目录 —— 顺序不能反：
        // 若工作流里是「锁着的」，这一同步必须已经是锁定语义，
        // 否则会先把目录拉回图片所在目录，锁就白存了。
        this._lirRestoreFolderLock?.();
        this._folderFilterSync?.();
      }, 0);
    };

    // 右键菜单兜底：前两条自动路径都没覆盖到时，手动刷一次。
    const onGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      let result;
      try {
        result = onGetExtraMenuOptions?.apply(this, arguments);
      } catch (err) {
        // 基类实现依赖 canvas 上的字段，别让它把我们的菜单项一起带走
        console.warn("[LoadImageRecursive] getExtraMenuOptions 基类调用失败：", err);
      }
      options.push(null, {
        content: this._lirIsFolderLocked?.()
          ? "🔒 目录已锁定（左右箭头停用，点此解锁）"
          : "🔓 锁定目录（停用左右箭头）",
        callback: () => this._lirSetFolderLock?.(!this._lirIsFolderLocked?.()),
      });
      options.push(null, {
        content: "⟳ 刷新图片列表",
        callback: () => this._folderFilterReload?.(),
      });
      return result;
    };
  },
});
