/**
 * 宠物页面的内联样式与注入：只有伪类、过渡、指针手势与光标这类行内 style 表达不了的东西。
 * 菜单与悬浮提示的样式与桌面端共用同一份（`shared/menu`、`shared/tooltip`），不在这里抄第二份。
 * 注入按 `data-plugin-css` 去重：同一页面重复挂载不会长第二份样式。
 * @module dsh-pet/src/client/pet/css
 */
import { ROUTE_PATH } from '../../shared/constants.ts';
import { appendPetLayer } from '../../shared/dom-layer.ts';
import { MENU_CSS } from '../../shared/menu.ts';
import { TOOLTIP_CSS } from '../../shared/tooltip.ts';

/** alpha 修正滤镜 SVG 的 id，CSS 与注入的 SVG 共用。 */
const ALPHA_FIX_ID = 'dsh-pet-alpha-fix';

/**
 * 滤镜定义 SVG 的布局兜底样式：固定定位到原点、零尺寸、裁掉溢出、不拦指针。
 *
 * 与 ensureAlphaFilter 里写的行内 style 同义，多出来的 `!important` 用来压住本次注入之前
 * 就已经在页面上的同款节点（刷新前的旧 bundle 留下的那个）。
 */
const ALPHA_FILTER_SVG_CSS =
  'svg[data-dsh-pet-alpha-fix]{position:fixed!important;top:0!important;left:0!important;' +
  'width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important}';

/** 宠物页面样式表。 */
const PET_CSS = [
  '.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
  '.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
  // 与桌面 helper 同一条修正，滤镜定义见 ensureAlphaFilter。
  '.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center;filter:url(#dsh-pet-alpha-fix)}',
  '.dsh-pet-video.is-front{opacity:1}',
  // 兜底：滤镜定义节点必须留在文档里，但它绝不能参与宿主的布局（见 ensureAlphaFilter）。
  // 行内的零尺寸 SVG 会在 #root 之后生成一个匿名行盒，把 documentElement 撑高约 18–22px；
  // 整页从此可滚动，DSH 桌面端那条 position:absolute 的拖拽条（data-windows-titlebar）随之被顶出
  // 视口——表现就是主窗口拖不动、双击顶部空白也不能最大化。!important 用来压住在处理本页之前
  // 就已被旧 bundle 注入的同款节点（刷新前的残留）。
  ALPHA_FILTER_SVG_CSS,
  // 触屏拖拽必需：缺 touch-action:none 时浏览器会把手势判成滚动并触发 pointercancel；
  // 两条 -webkit-* 抑制长按选中与 iOS 长按系统菜单。
  `.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:url("${ROUTE_PATH}/pic/cursor-grab.png") 16 16, grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}`,
  `.dsh-pet-hit.dragging{cursor:url("${ROUTE_PATH}/pic/cursor-grabbing.png") 16 16, grabbing}`,
  '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
  // 统一右键菜单样式，与桌面注入同一份。
  MENU_CSS,
  // 悬浮提示样式，与桌面注入同一份。
  TOOLTIP_CSS,
].join('\n');

/** 注入去重用的标记值，写在 `<style>` 的 `data-plugin-css` 上。 */
const cssTag = 'dsh-pet/style.css';

/**
 * 注入 alpha 修正滤镜：素材「透明」背景实测恒为 alpha 1/255，扣掉一档归零，
 * 宠物本体只降一档（≤1/255，不可见）；同一页面只注入一次。
 */
function ensureAlphaFilter(): void {
  if (document.querySelector('svg[data-dsh-pet-alpha-fix]') !== null) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-dsh-pet-alpha-fix', '');
  // 滤镜定义必须留在文档里（filter:url(#…) 按同文档 id 解析），但它绝不能参与宿主的布局：
  // 节点是行内元素，挂在 #root（100% 视口高）之后会多出一个匿名行盒，把文档撑高约 20px——
  // 整页可滚动，桌面端那条拖拽条（data-windows-titlebar）就被顶出视口，主窗口随之拖不动、
  // 双击顶部也不能最大化。固定定位 + 零尺寸让它彻底脱离流，也一并躲开溢出区。
  svg.style.position = 'fixed';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.style.overflow = 'hidden';
  svg.style.pointerEvents = 'none';
  const defs = document.createElementNS(NS, 'defs');
  const filter = document.createElementNS(NS, 'filter');
  filter.id = ALPHA_FIX_ID;
  const transfer = document.createElementNS(NS, 'feComponentTransfer');
  const func = document.createElementNS(NS, 'feFuncA');
  func.setAttribute('type', 'linear');
  func.setAttribute('slope', '1');
  func.setAttribute('intercept', '-0.0039215686');
  transfer.appendChild(func);
  filter.appendChild(transfer);
  defs.appendChild(filter);
  svg.appendChild(defs);
  appendPetLayer(svg);
}

/** 注入宠物页面样式，每页只注入一次；没有 document 时静默返回。 */
export function injectPetCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + cssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = cssTag;
  tag.textContent = PET_CSS;
  document.head.appendChild(tag);
  ensureAlphaFilter();
}
