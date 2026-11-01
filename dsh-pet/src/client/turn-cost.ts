/**
 * 对话界面「本轮花费」补丁：在每条回复的「用量 20.5K tok」右侧补一句 `¥0.0021`。
 *
 * 为什么只能在 DOM 层做：DSH 的用量徽标是 ui-chat 内部组件（`TurnUsagePanel`），第三方只有
 * `conversation.chat.assistant-actions` 一个插槽，而它在徽标**左边**（actions 行里先渲染 extraActions，
 * 再渲染 `<span>[用量, 时间]</span>`）。要落在「用量右侧」，只能给徽标容器打一个属性、用 `::after`
 * 画出来——和 nav-icon 一样只打 `data-*` 标记，不动 DOM 结构：React 会对自己创建的节点做 removeChild，
 * 插进去的节点迟早会把它惹毛。
 *
 * 视觉上不是「多一个数字」，而是把金额接成用量徽标的第二段：`用量 21K tok · ¥0.0021`，后面才是时间。
 * 这也是 DSH 自己表达次级信息的方式（徽标内部就用「·」连接缓存命中率）。
 *
 * 金额由宿主算好（src/host/turn-costs）：它按轮次记 `sessionId → turn → ¥0.0021`，这里只做匹配与上色。
 * 认不出价目、或者这一轮早于本次启动，就没有属性、也就没有这一句——绝不在这里凭 token 数估算。
 *
 * 降级：缺 document / MutationObserver 时什么都不装；认不出徽标（DSH 改版）时静默不做，只在控制台留一条。
 *
 * @module dsh-pet/src/client/turn-cost
 */
import { getStateSnapshot, subscribeStateSnapshot } from './state-service.ts';

/** 注入的样式表去重标记（与宠物页面 / 导航图标同一套 `data-plugin-css` 约定）。 */
const STYLE_TAG = 'dsh-pet/turn-cost.css';

/** 打在用量徽标容器上的标记属性：`::after` 用它取金额文本。 */
export const COST_MARK = 'data-dsh-pet-cost';

/** 一轮的落点：DSH 在每轮尾部容器上带 `data-turn-tail="<turn>"`。 */
const TURN_SELECTOR = '[data-turn-tail]';

/** 会话容器：`data-conversation-session="<sessionId>"`，用它在多会话 / 多标签页之间对齐金额。 */
const SESSION_SELECTOR = '[data-conversation-session]';

/** 用量徽标的触发器：整行里唯一带 `aria-haspopup="dialog"` 的按钮（点开用量明细）。 */
const USAGE_TRIGGER = 'button[aria-haspopup="dialog"]';

/** 账本：sessionId → turn → 金额文本。 */
export type TurnCostMap = Record<string, Record<string, string>>;

/**
 * 金额的样式：当作用量徽标的**第二段**来画。
 *
 * DSH 自己的次级信息就是用「·」接在主页后面的（`reading()` 里那个 sep 圆点），这里沿用同一套语言：
 * `用量 21K tok · ¥0.0021`，然后才是时间。分隔点用 `\00a0` 跟着不换行，负 4px 把金额收进按钮的
 * 右侧内边距（8px），间距因此和徽标内部的 `gap:4px` 对齐——看着像一句话，而不是夹在中间的一串灰字。
 * 字号、行高、数字对齐都抄徽标；颜色取次级文本而不是三级（三级太淡，和右边的时间糊在一起）。
 */
const COST_CSS =
  '[data-dsh-pet-cost]::after{content:"·\\00a0" attr(data-dsh-pet-cost);margin-inline-start:-4px;' +
  'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);' +
  'line-height:calc(24px + var(--dsh-content-font-delta,0px));' +
  'font-variant-numeric:tabular-nums;font-weight:500;' +
  'color:var(--dsw-alias-label-secondary,currentColor);white-space:nowrap}';

/**
 * 从 /state 的 `sections.turnCost` 里取出账本；形状不对就当没有。
 *
 * 只认「两层都是对象、值是非空字符串」的形状：坏数据宁可少标几轮，也不能把 `[object Object]`
 * 画到对话里。
 *
 * @param raw - 叶子里的 data（外部输入，逐层校验）。
 * @returns 校验过的账本；没有数据时返回空对象。
 */
export function readTurnCosts(raw: unknown): TurnCostMap {
  const out: TurnCostMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sessionId, turns] of Object.entries(raw as Record<string, unknown>)) {
    if (!turns || typeof turns !== 'object' || Array.isArray(turns)) continue;
    const costs: Record<string, string> = {};
    for (const [turn, cost] of Object.entries(turns as Record<string, unknown>)) {
      if (turn === '' || typeof cost !== 'string' || cost === '') continue;
      costs[turn] = cost;
    }
    if (Object.keys(costs).length > 0) out[sessionId] = costs;
  }
  return out;
}

/** 当前快照里的账本（宠物轮询每秒刷新一次，这里直接读最近一拍）。 */
function currentCosts(): TurnCostMap {
  const snapshot = getStateSnapshot();
  return readTurnCosts(snapshot?.sections.turnCost?.data);
}

/**
 * 把账本画到 DOM 上：逐轮找用量徽标容器，打上/更新/摘掉标记属性。
 *
 * 纯 DOM 操作，不装观察者、不注入样式——便于用一个假 document 单测。
 *
 * @param doc - 文档（真实 DOM 或测试替身）。
 * @param costs - 账本；没有对应轮次时把已有标记摘掉（宁可没有，也不留上一轮的金额）。
 */
export function paintTurnCosts(doc: Document, costs: TurnCostMap): void {
  const rows = doc.querySelectorAll(TURN_SELECTOR);
  for (const row of Array.from(rows)) {
    const turn = row.getAttribute('data-turn-tail') ?? '';
    const session = row.closest(SESSION_SELECTOR)?.getAttribute('data-conversation-session') ?? '';
    // 会话或轮次认不出来就不标：宁可不显示，也不能把别的会话的金额贴到这行上。
    const cost = turn === '' || session === '' ? undefined : costs[session]?.[turn];
    // 用量徽标的容器（`<span>[按钮]</span>`）：标记打在它上面，`::after` 就落在徽标右侧、时间左侧。
    const target = row.querySelector(USAGE_TRIGGER)?.parentElement ?? null;
    if (target === null) continue;
    if (cost === undefined) {
      if (target.hasAttribute(COST_MARK)) target.removeAttribute(COST_MARK);
    } else if (target.getAttribute(COST_MARK) !== cost) {
      target.setAttribute(COST_MARK, cost);
    }
  }
}

/** 注入样式与去重标记；已注入过就什么都不做。 */
function injectCostCss(doc: Document): void {
  if (doc.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
  const tag = doc.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = COST_CSS;
  doc.head.appendChild(tag);
}

/** 安装补丁时注入的能力（测试替换用；生产路径全用真实实现）。 */
export interface TurnCostDeps {
  /** 文档；缺省用全局 document。 */
  doc?: Document;
  /** 状态快照订阅；缺省订阅宠物轮询。 */
  subscribe?: (listener: () => void) => () => void;
  /** 读账本；缺省读最近一拍 /state。 */
  costs?: () => TurnCostMap;
}

/**
 * 安装补丁：订阅状态 + 观察对话 DOM，把每轮花费刷到用量徽标右侧。
 *
 * @param deps - 可替换的文档 / 订阅（测试用）。
 * @returns 卸载函数：断开观察者、退订、摘掉标记与样式。
 */
export function installTurnCostBadges(deps: TurnCostDeps = {}): () => void {
  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document);
  if (doc === undefined) return () => {};
  const MutObserver = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (MutObserver === undefined) {
    console.warn('[dsh-pet] 本轮花费：缺 MutationObserver，已跳过');
    return () => {};
  }

  const readCosts = deps.costs ?? currentCosts;
  // 订阅的是「有新的一拍」而不是状态本身：账本变了就重画，没变也重画（DOM 可能刚重建）。
  const subscribe: (listener: () => void) => () => void =
    deps.subscribe ?? ((listener) => subscribeStateSnapshot(() => listener()));

  injectCostCss(doc);

  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 合并一小段时间内的多次 DOM 变动：流式输出时子树每秒变几十次，而重绘要把整页的轮尾扫一遍，
   * 逐次重绘没必要（金额只在一轮结束时才出现）。200ms 的延迟看不出来。
   */
  const schedulePaint = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      paintTurnCosts(doc, readCosts());
    }, 200);
  };

  schedulePaint();
  const unsubscribe = subscribe(schedulePaint);
  const observer = new MutObserver(schedulePaint);
  // 只盯子节点增删：折叠展开、流式追加、切会话都会重建节点；属性变化与我们无关。
  observer.observe(doc.body, { childList: true, subtree: true });

  return () => {
    if (timer !== null) clearTimeout(timer);
    observer.disconnect();
    unsubscribe();
    for (const el of Array.from(doc.querySelectorAll('[' + COST_MARK + ']'))) el.removeAttribute(COST_MARK);
  };
}
