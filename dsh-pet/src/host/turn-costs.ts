/**
 * 每轮花费账本：sessionId + turn → 花费文本，供对话界面按轮次标注「这一轮多少钱」。
 *
 * 不负责算钱（归 ./pricing）、不负责落盘（归 plugin/turn-cost-file）、也不负责传给前端
 * （归 plugin/turn-cost-persistence 包着的 publishTurnCosts）。
 *
 * 为什么有磁盘副本：账本唯一的数据来源是实时 `session/event` 的 `turn/end`，而 DSH 重启后
 * 把会话日志作为 seed 载入、**不会**重放给观察者（dsh-session：「Seed events never publish on
 * `session/event`」）。只放内存的话，进程一退金额就永久消失；落一份到磁盘再在启动时 hydrate，
 * 才谈得上「重启后还看得见」。
 *
 * 三个约束始终成立：
 *   ① 同一轮重复结算会覆盖；认不出价目时把该轮删掉（宁可没有，也不留一个过期数字）。
 *   ② 有上限（会话数 / 每会话轮次 / 留存天数），文件与 /state 都不会无限长。
 *   ③ 过期的会话在 hydrate 时丢掉——旧金额留在磁盘上比丢掉更糟。
 *
 * @module dsh-pet/src/host/turn-costs
 */
/** 每个会话保留的轮次数：落盘后不必跟 /state 抢体积，但也不能无限长。 */
export const MAX_TURNS_PER_SESSION = 200;

/** 同时保留的会话数：多标签页 / 多会话并行时按最近使用淘汰。 */
export const MAX_SESSIONS = 20;

/** 留存天数：超过这个天数的会话在载入时丢掉（旧账既占地方，也没人再翻）。 */
export const RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/** 一个会话的账：turn → 金额文本，以及最后一次写入时刻（会话淘汰 + 留存判定的依据）。 */
export interface TurnCostEntry {
  /** 最后一次写入的毫秒时间戳。 */
  at: number;
  /** turn → 金额文本（`¥0.0021`）。 */
  costs: Record<string, string>;
}

/** 磁盘形状：sessionId → 会话的账；hydrate / dump 共用这一份。 */
export type TurnCostDiskMap = Record<string, TurnCostEntry>;

/** 一个会话的账（内存形状：Map 保证迭代顺序 = 写入顺序，trim 靠它丢最早的那一轮）。 */
interface SessionCosts {
  costs: Map<string, string>;
  at: number;
}

/** 外部输入是不是一个普通对象（数组、null、原始值都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 轮次花费账本（内存，有上限；磁盘副本由调用方读写）。 */
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
   * @returns true = 账本内容变了（调用方据此决定要不要写 /state 与落盘）。
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

  /**
   * 落盘用的账本（比 {@link snapshot} 多带每个会话的 `at`）。
   *
   * @returns 可直接 JSON 化的账本；调用方不需要再复制。
   */
  dump(): TurnCostDiskMap {
    const out: TurnCostDiskMap = {};
    for (const [sessionId, entry] of this.sessions) {
      if (entry.costs.size === 0) continue;
      const costs: Record<string, string> = {};
      for (const [turn, cost] of entry.costs) costs[turn] = cost;
      out[sessionId] = { at: entry.at, costs };
    }
    return out;
  }

  /**
   * 用磁盘上的账本重建内存账本（启动时调用一次）。
   *
   * 逐层校验、逐条丢弃：坏数据宁可少几轮金额，也不能让一句 `[object Object]` 进 /state。
   * 超过 {@link RETENTION_MS} 的会话、超过上限的会话与轮次都在这里裁掉——**先裁后装**，
   * 免得刚载入就带着一堆积压。
   *
   * @param raw - 磁盘上解析出来的对象（外部输入）；形状不对就当没有。
   * @param now - 当前时刻（测试注入固定时钟）。
   */
  hydrate(raw: unknown, now: number = Date.now()): void {
    if (!isRecord(raw)) return;
    const loaded: { sessionId: string; entry: SessionCosts }[] = [];
    for (const [sessionId, value] of Object.entries(raw)) {
      if (sessionId === '' || !isRecord(value) || !isRecord(value.costs)) continue;
      // 时间戳缺失或坏掉时按「刚刚写过」处理：宁可多留一个会话，也不因为一个坏字段丢掉整份账。
      const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : now;
      if (now - at > RETENTION_MS) continue;

      const costs = new Map<string, string>();
      for (const [turn, cost] of Object.entries(value.costs)) {
        if (turn === '' || typeof cost !== 'string' || cost === '') continue;
        costs.set(turn, cost);
      }
      if (costs.size === 0) continue;
      const entry: SessionCosts = { costs, at };
      this.trim(entry);
      loaded.push({ sessionId, entry });
    }

    // 载入是异步的：这段窗口里可能已经有一轮结完并记了进来。把它们合进来（内存里的值优先），
    // 不能因为「磁盘上的账比较旧」就把刚记下的钱丢掉。
    for (const [sessionId, entry] of this.sessions) {
      const same = loaded.find((item) => item.sessionId === sessionId);
      if (same === undefined) {
        loaded.push({ sessionId, entry });
        continue;
      }
      for (const [turn, cost] of entry.costs) same.entry.costs.set(turn, cost);
      same.entry.at = Math.max(same.entry.at, entry.at);
      this.trim(same.entry);
    }

    // 按最后一次写入时刻升序装回去：Map 的迭代顺序 = 淘汰顺序（最早的先丢）。
    loaded.sort((a, b) => a.entry.at - b.entry.at);
    const keep = loaded.slice(Math.max(0, loaded.length - MAX_SESSIONS));
    this.sessions.clear();
    for (const item of keep) this.sessions.set(item.sessionId, item.entry);
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
