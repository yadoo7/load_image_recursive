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
 */

import { app } from "../../../scripts/app.js";

const ALL = "(全部)";
const NODE_NAME = "LoadImageRecursive";
const OBJECT_INFO_URL = "/object_info/" + NODE_NAME;

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
        return slash === -1 ? ALL : value.slice(0, slash);
      };

      const applyFilter = () => {
        const folder = folderWidget.value;
        imageWidget.options.values =
          !folder || folder === ALL
            ? all.slice()
            : all.filter((v) => v.startsWith(folder + "/"));
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
        syncFolderFromImage();
        noteUnknownValue();
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
      };

      this._folderFilterSync();
    };

    // 从工作流加载时 configure() 直接写值，不会触发 callback，
    // 所以这里补一次同步，让目录下拉对上已保存的那张图。
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConfigure?.apply(this, arguments);
      setTimeout(() => this._folderFilterSync?.(), 0);
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
        content: "⟳ 刷新图片列表",
        callback: () => this._folderFilterReload?.(),
      });
      return result;
    };
  },
});
