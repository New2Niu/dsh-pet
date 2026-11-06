/**
 * 插件自建浮层挂到宿主 `<body>` 的唯一入口。
 *
 * 为什么不能直接 `document.body.appendChild(...)`：DSH 桌面端（macOS）有一条
 * `html[data-platform=darwin] body>:not(#root){-webkit-app-region:no-drag}`。直接挂在 body 上的节点
 * 会被当成一块 no-drag 矩形，Chromium 再把它们从拖拽区里**几何相减**。本插件的吃白饭层与分数飘字层
 * 都是 `position:fixed;inset:0`，一减就等于整窗没有拖拽区——主窗口拖不动、双击顶部空白也不最大化，
 * 而且跟宠物显不显示无关（这些层在插件加载时就建好了）。
 *
 * 行内 `style` 的优先级高于那条作者规则（它没有 `!important`）。重置值必须写 `initial`：
 * `none` 不在该属性的关键字表里，写进去会被丢掉（实测 computed 仍是 `no-drag`）。
 * 宿主自己也用 `[inert]{-webkit-app-region:initial}` 做同类重置，这里与它保持一致。
 * @module dsh-pet/src/shared/dom-layer
 */

/** 本函数接得住的节点：普通元素，以及滤镜定义那个 `<svg>`（同样挂在 body 下）。 */
type LayerElement = HTMLElement | SVGElement;

/** 标记属性：一眼看出这个 body 子节点是插件的浮层，也方便宿主侧排查。 */
const LAYER_ATTR = 'data-dsh-pet-layer';

/**
 * 把浮层挂到 `<body>`，并抵消宿主给「非 #root 子节点」打的 no-drag。
 *
 * @param el - 待挂载的浮层根节点。
 * @returns 同一个节点，方便链式使用。
 */
export function appendPetLayer<T extends LayerElement>(el: T): T {
  el.setAttribute(LAYER_ATTR, '');
  el.style.setProperty('-webkit-app-region', 'initial');
  document.body.appendChild(el);
  return el;
}
