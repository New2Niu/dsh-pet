/**
 * 每轮花费的短期账本：sessionId + turn → 花费文本，供对话界面按轮次标注「这一轮多少钱」。
 *
 * 不负责算钱（归 ./pricing），也不负责传给前端（归 plugin/work-status-bridge 的 publishTurnCosts）。
 * 只保存在内存里且有上限：这是给「刚聊完那几轮」看的注脚，不是账本——历史轮次重启后就不再有金额，
 * 磁盘上留下旧金额反而会和真实账单对不上。
 * 始终成立：同一轮重复结算会覆盖；认不出价目时把该轮删掉（宁可没有，也不留一个过期数字）。
 *
 * @module dsh-pet/src/host/turn-costs
 */
/** 每个会话保留的轮次数：再老的轮次气泡早就翻走了，留着只会让 /state 变大。 */
export const MAX_TURNS_PER_SESSION = 60;

/** 同时保留的会话数：多标签页 / 多会话并行时按最近使用淘汰。 */
export const MAX_SESSIONS = 6;

/** 一个会话的账：turn → 金额文本，以及最后一次写入时刻（会话淘汰用）。 */
interface SessionCosts {
  costs: Map<string, string>;
  at: number;
}

/** 轮次花费账本（内存，有上限）。 */
export class TurnCostStore {
  declare private readonly sessions: Map<string, SessionCosts>;

  constructor() {
    this.sessions = new Map();
  }

  /**
   * 记一轮的花费。
   *
   * @param sessionId - 会话 id。
   * @param turn - 该会话内的轮次序号（DSH 的 `turn/end` 事件里的 turn）。
   * @param cost - 花费文本（`¥0.0021`）；null 表示这一轮没有可信金额，把该轮清掉。
   * @returns true = 账本内容变了（调用方据此决定要不要写 /state）。
   */
  record(sessionId: string, turn: string, cost: string | null): boolean {
    if (sessionId === '' || turn === '') return false;
    const existing = this.sessions.get(sessionId);
    // 没金额且本来就没记过：什么都不用做（也不该为它建一个空会话条目）。
    if (cost === null && !existing?.costs.has(turn)) return false;

    const entry: SessionCosts = existing ?? { costs: new Map(), at: 0 };
    const before = entry.costs.get(turn) ?? null;
    if (cost === null) entry.costs.delete(turn);
    else entry.costs.set(turn, cost);
    entry.at = Date.now();
    // 重建而不是原地改：Map 的迭代顺序即「写入顺序」，重新 set 才能把这一轮排到最新。
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
    this.trim(entry);
    this.evictSessions();
    return before !== cost;
  }

  /** 当前账本快照（普通对象，直接可序列化进 /state）。 */
  snapshot(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [sessionId, entry] of this.sessions) {
      if (entry.costs.size === 0) continue;
      const costs: Record<string, string> = {};
      for (const [turn, cost] of entry.costs) costs[turn] = cost;
      out[sessionId] = costs;
    }
    return out;
  }

  /** 丢掉某个会话的全部金额（会话被清 / 重启会话时叫）。 */
  clear(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** 单个会话的轮次上限：超了就从最早的轮次开始丢。 */
  private trim(entry: SessionCosts): void {
    while (entry.costs.size > MAX_TURNS_PER_SESSION) {
      const oldest = entry.costs.keys().next();
      if (oldest.done === true) break;
      entry.costs.delete(oldest.value);
    }
  }

  /** 会话数上限：淘汰最久没写入的那个（仍保留最近用过的几个标签页）。 */
  private evictSessions(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const [sessionId, entry] of this.sessions) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestId = sessionId;
        }
      }
      if (oldestId === null) return;
      this.sessions.delete(oldestId);
    }
  }
}
