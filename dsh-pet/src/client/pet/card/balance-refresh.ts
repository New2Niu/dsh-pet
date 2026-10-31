/**
 * 点击桌宠触发的余额刷新：调用方先用最近一次快照弹气泡，这里只负责节流后请宿主刷新一次。
 *
 * 不决定气泡弹不弹（归 ./bubble-slots），也不解析结果（归 /state 轮询）：动作端点只回执，
 * 数据仍旧从 sections.balance 送来。
 * 始终成立：同一页面内两次请求至少间隔 {@link BALANCE_CLICK_GAP_MS}——点宠物是高频交互，
 * 每次点都打一次服务商接口既慢又可能被限流；这期间照旧用已有快照答复。
 *
 * @module dsh-pet/src/client/pet/card/balance-refresh
 */
import { ROUTE_PATH } from '../../../shared/constants.ts';
import { postAction } from '../../../shared/state.ts';

/** 两次点击刷新之间的最短间隔（ms）：余额本身就是 30 分钟一拍的慢数据，1 分钟足够「点一下就是最新」。 */
export const BALANCE_CLICK_GAP_MS = 60_000;

/** 上一次请求的时刻；null = 本次页面还没请求过。用 null 而不是 0：注入的时钟可能真的从 0 起算。 */
let lastRequestAt: number | null = null;

/**
 * 请求一次余额刷新；被节流拦下时什么都不做。
 *
 * @param now - 当前时刻（ms）；测试注入固定时钟。
 * @returns true = 真的发出了请求，false = 还在节流窗口内。
 */
export function requestBalanceRefresh(now: number = Date.now()): boolean {
  if (lastRequestAt !== null && now - lastRequestAt < BALANCE_CLICK_GAP_MS) return false;
  lastRequestAt = now;
  // 结果由 /state 送回，这里不等待也不读返回值（动作端点失败不影响已有快照的展示）。
  void postAction(ROUTE_PATH + '/balance');
  return true;
}

/**
 * 清空节流窗口；测试用，让每个用例从「本页还没请求过」开始。
 * @internal 只给测试重置模块内状态，不对外承诺。
 */
export function resetBalanceRefresh(): void {
  lastRequestAt = null;
}
