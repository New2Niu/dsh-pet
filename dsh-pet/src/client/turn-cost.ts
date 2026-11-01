/**
 * 对话界面「本轮花费」：注册进 `conversation.chat.turnTail` 插槽，在每条回复的动作行
 * （复制 / 分支 / 用量 / 时间）**上方**单独占一行小字：`本轮 ¥0.0021`。
 *
 * 为什么不再贴着用量徽标：DSH 的「用量 20.5K tok」是 ui-chat 内部组件（`TurnUsagePanel`），
 * 它外面那个 `.endInfo` 是 `min-width:0` 的 flex 子项——往里塞任何内容都会跟徽标抢宽度，
 * 结果是徽标自己先被省略号截掉（`用量 21.2K tok…`），金额反倒被挤在用量与时间之间。
 * 第三方能拿到的只有两个插槽：`conversation.chat.assistant-actions`（动作图标之间）和
 * `conversation.chat.turnTail`（动作行之前），都没有「用量右侧」这个位置。
 *
 * 选 turnTail 的两个理由：
 *   ① props 里现成带 `turn`（轮次号）与框架标准工具包的 `sessionId`，正好对上宿主账本
 *      `sessionId → turn → 金额`，不用再从 DOM 反查，也就没有 React 管教外来节点的问题；
 *   ② 语义更贴：钱是**一轮**的属性，不是某条消息的动作，单独一行当注脚比塞进按钮里干净。
 *
 * 金额由宿主算好（src/host/turn-costs）：按轮次记 `sessionId → turn → ¥0.0021`，认不出价目、
 * 或这一轮早于本次启动，就没有值——组件直接返回 null，绝不在这里凭 token 数估算。
 *
 * 降级：缺插槽声明时 `ctx.slots.inject` 一直等着，界面什么都不显示；缺 document 时不注入样式。
 *
 * @module dsh-pet/src/client/turn-cost
 */
import { getStateSnapshot, subscribeStateSnapshot } from './state-service.ts';
import type { Key } from './settings/locales/index.ts';
import type { PollState } from '../shared/state.ts';

/** 注入的样式表去重标记（与宠物页面 / 导航图标同一套 `data-plugin-css` 约定）。 */
const STYLE_TAG = 'dsh-pet/turn-cost.css';

/** 组件根节点的类名；样式只认它，避免污染 DSH 自己的结构。 */
const COST_CLASS = 'dsh-pet-turn-cost';

/** 账本：sessionId → turn → 金额文本。 */
export type TurnCostMap = Record<string, Record<string, string>>;

/**
 * 金额小行的样式。
 *
 * 位置靠负 margin 收：`turnTail` 所在的列是 `gap:16px` 的 flex，动作行自己还有 4px 上边距；
 * 不加补偿的话正文与动作行之间会凭空多出 20px 空白。上下各收一点后，整块高度比原来只多几像素，
 * 视觉上就是正文脚下多了一行脚注。
 *
 * 字号 / 行高抄用量徽标那一套（次级字号再小 1px）；颜色取三级文本——它是注脚，不该抢正文。
 * 历史轮次跟随 DSH 自己的动作行：`[data-actions-reveal=hover]` 的块默认藏起来，悬停或聚焦再现，
 * 这样往下翻旧对话时不会被一屏金额糊住；最新一轮是 `always`，一直可见。
 */
const COST_CSS =
  '.' +
  COST_CLASS +
  '{display:inline-flex;align-items:center;gap:4px;margin-block:-8px -10px;' +
  'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);' +
  'line-height:calc(22px + var(--dsh-content-font-delta,0px));' +
  'color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}' +
  '.' +
  COST_CLASS +
  '-label{opacity:.75}' +
  '.' +
  COST_CLASS +
  '-amount{font-weight:500}' +
  '@media (hover:hover){[data-actions-reveal=hover] .' +
  COST_CLASS +
  '{opacity:0;transition:opacity 80ms}' +
  '[data-actions-reveal=hover]:hover .' +
  COST_CLASS +
  ',[data-actions-reveal=hover]:focus-within .' +
  COST_CLASS +
  '{opacity:1}}';

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

/**
 * 从一次轮询快照里取账本。
 *
 * @param snapshot - 最近一拍 /state；还没拉到过时为 null。
 * @returns 校验过的账本；没有快照时是空对象。
 */
export function costsOf(snapshot: PollState | null): TurnCostMap {
  return readTurnCosts(snapshot?.sections.turnCost?.data);
}

/**
 * 取某个会话某一轮的金额。
 *
 * @param map - 账本。
 * @param sessionId - 会话 id（插槽的框架标准 props）。认不出就不匹配，绝不错贴到别的会话上。
 * @param turn - 轮次号（`TurnLocation.turn`）；数字或数字字符串都收。
 * @returns 金额文本；对不上号时 undefined。
 */
export function turnCostOf(map: TurnCostMap, sessionId: unknown, turn: unknown): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  if (typeof turn !== 'number' && typeof turn !== 'string') return undefined;
  const key = String(turn);
  if (key === '') return undefined;
  return map[sessionId]?.[key];
}

/**
 * 取最近一拍里某一轮的金额（组件与测试共用的唯一读法）。
 *
 * @param snapshot - 最近一拍 /state。
 * @param sessionId - 会话 id。
 * @param turn - 轮次号。
 * @returns 金额文本；没有快照 / 对不上号时 undefined。
 */
export function pickTurnCost(snapshot: PollState | null, sessionId: unknown, turn: unknown): string | undefined {
  return turnCostOf(costsOf(snapshot), sessionId, turn);
}

/** 造金额小行需要的最少 react 能力（宿主注入，不直接 import react）。 */
export interface TurnCostTailDeps {
  /** 创建元素；子节点写进 `props.children`（`react/jsx-runtime` 的 jsx 契约）。 */
  h: (type: unknown, props?: Record<string, unknown> | null) => unknown;
  /** 状态。 */
  useState: <T>(init: T | (() => T)) => [T, (next: T) => void];
  /** 副作用；返回函数作为清理。 */
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => void;
  /** 文案。 */
  t: (key: Key) => string;
}

/** `turnTail` 插槽给到的 props（只取本项目用到的两个）。 */
export interface TurnCostTailProps {
  /** 这一轮的定位；`turn` 是轮次号。 */
  readonly turn?: { readonly turn?: unknown } | undefined;
  /** 框架标准工具包给的会话身份。 */
  readonly sessionId?: unknown;
}

/**
 * 造「本轮花费」小行组件。
 *
 * 没有金额就返回 null——插槽允许条目返回 null，不会占位。
 *
 * @param deps - 注入的 react 能力与文案。
 * @returns 插槽组件：props 见 {@link TurnCostTailProps}。
 */
export function makeTurnCostTail(deps: TurnCostTailDeps): (props: TurnCostTailProps) => unknown {
  const { h, useState, useEffect, t } = deps;
  return function TurnCostTail(props: TurnCostTailProps): unknown {
    const sessionId = props.sessionId;
    const turn = props.turn?.turn;
    // 首帧就带值，避免「先空一行、下一拍金额才跳出来」的闪烁。
    const [cost, setCost] = useState<string | undefined>(() => pickTurnCost(getStateSnapshot(), sessionId, turn));

    useEffect(() => {
      const sync = (): void => setCost(pickTurnCost(getStateSnapshot(), sessionId, turn));
      sync();
      // 轮询每秒一拍：值没变时 setState 的是同一个字符串，React 自己跳过重渲染。
      return subscribeStateSnapshot(sync);
    }, [sessionId, turn]);

    if (cost === undefined) return null;
    return h('div', {
      className: COST_CLASS,
      title: t('cost.hint'),
      children: [
        h('span', { className: COST_CLASS + '-label', children: t('cost.label') }),
        h('span', { className: COST_CLASS + '-amount', children: cost }),
      ],
    });
  };
}

/**
 * 注入金额小行的样式（幂等）。
 *
 * @returns 释放函数：移除本次创建的那张样式表；已注入过时是空操作。
 */
export function injectTurnCostCss(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return () => {};
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = COST_CSS;
  document.head.appendChild(tag);
  return () => {
    if (tag.isConnected) tag.remove();
  };
}
