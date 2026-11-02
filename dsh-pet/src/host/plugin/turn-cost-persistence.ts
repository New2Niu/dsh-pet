/**
 * 每轮花费账本的持久化：启动载入、写 /state 时顺带节流落盘、卸载时收尾。
 *
 * 为什么单独一层：`../turn-costs` 是纯内存账本，`./turn-cost-file` 只管文件，这里负责把两者
 * 接到装配线上——谁在什么时候读、什么时候写、写之前要不要等上一笔。
 *
 * 三条时序：
 *   ① **载入**：插件装配时读一次文件 → hydrate → 立刻写一拍 /state。不写这一拍，前端要等下一次
 *      轮次结束才看得到旧金额（首拍是空叶子）。
 *   ② **落盘**：每轮结算后先写 /state（人看得见的那个），再排一个防抖窗口；窗口内继续有钱进来
 *      就合并成一次写。一次 `turn/end` 一个文件写的写法会把磁盘刷成筛子。
 *   ③ **收尾**：卸载时把挂起的窗口立刻写掉——插件重载 / DSH 退出的那一刻，最后一轮的钱也得留下。
 *
 * 写盘串行（前一笔结束才写下一笔）：rename 交错不会坏文件，但会让后写的旧数据盖掉新数据。
 *
 * @module dsh-pet/src/host/plugin/turn-cost-persistence
 */
import { readTurnCostFile, writeTurnCostFile } from './turn-cost-file.ts';
import type { TurnCostDiskMap, TurnCostStore } from '../turn-costs.ts';
import type { LoggerLike } from '../log-file.ts';

/** 落盘防抖窗口：一轮结算后等这么久再写；期间的更多轮次合并成一次。 */
export const SAVE_DELAY_MS = 3000;

/** 持久化层的输入。 */
export interface TurnCostPersistenceInput {
  /** 账本文件绝对路径。 */
  file: string;
  /** 告警出口。 */
  log: LoggerLike;
  /** 内存账本（与 session-watch 共用同一个实例）。 */
  store: TurnCostStore;
  /** 写 /state 的出口（work-status-bridge 的 publishTurnCosts）。 */
  publish: (costs: Record<string, Record<string, string>>) => void;
  /** 防抖窗口；测试注入短窗口。 */
  delayMs?: number;
  /** 读文件的实现；测试注入替身（默认 {@link readTurnCostFile}）。 */
  read?: (file: string, log: LoggerLike) => Promise<unknown>;
  /** 写文件的实现；测试注入替身（默认 {@link writeTurnCostFile}）。 */
  write?: (file: string, sessions: TurnCostDiskMap, log: LoggerLike) => Promise<void>;
}

/** 持久化层对外的四个动作。 */
export interface TurnCostPersistence {
  /** 启动载入：读文件 → hydrate → 写一拍 /state；失败只记日志。 */
  load: () => Promise<void>;
  /** 记完一轮后调用：先写 /state，再安排落盘（取代裸的 publishTurnCosts）。 */
  publishAndSave: (costs: Record<string, Record<string, string>>) => void;
  /** 立刻把挂起的窗口写掉（卸载 / 测试用）。 */
  flush: () => Promise<void>;
  /** 卸载：停掉窗口并写最后一次。 */
  dispose: () => void;
}

/**
 * 装配持久化层。
 *
 * @param input - 文件路径、日志、账本与 /state 出口。
 * @returns 载入 / 发布 + 落盘 / 收尾四个动作。
 */
export function createTurnCostPersistence(input: TurnCostPersistenceInput): TurnCostPersistence {
  const {
    file,
    log,
    store,
    publish,
    delayMs = SAVE_DELAY_MS,
    read = readTurnCostFile,
    write = writeTurnCostFile,
  } = input;

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 写盘队列：串起来写，避免后写的旧快照盖掉新快照。 */
  let writing: Promise<void> = Promise.resolve();
  let disposed = false;
  /**
   * 是否已经读过磁盘账本。
   *
   * 载入没完成之前**绝不写盘**：那时内存账本是空的（或只有刚记的一两轮），写下去就等于
   * 用半份账本把磁盘上几十天的记录整份覆盖掉。读失败也算「读过」——否则一次读错误会让
   * 这个进程永远不再落盘。
   */
  let hydrated = false;

  const writeNow = (): Promise<void> => {
    if (!hydrated) return Promise.resolve();
    const sessions = store.dump();
    writing = writing.then(() => write(file, sessions, log));
    return writing;
  };

  const schedule = (): void => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, delayMs);
  };

  const publishAndSave = (costs: Record<string, Record<string, string>>): void => {
    publish(costs);
    schedule();
  };

  const load = async (): Promise<void> => {
    // 不用初值：read 抛错时 finally 之后就走不到，raw 只在 try 正常结束时被读。
    let raw: unknown;
    try {
      raw = await read(file, log);
      // 卸载后才回来的结果直接丢掉：这时候内存账本可能已经被清，合进去反而会写回旧账。
      if (!disposed && raw !== null) store.hydrate(raw);
    } finally {
      hydrated = true;
    }
    if (disposed || raw === null) return;
    const costs = store.snapshot();
    // 空账本没必要推一拍：/state 首拍本来就是空的。
    if (Object.keys(costs).length > 0) publish(costs);
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return writeNow();
  };

  const dispose = (): void => {
    disposed = true;
    // 只有挂起没写的窗口才需要补一次：没有待写内容就别凭空多写一次文件。
    if (timer !== null) void flush();
  };

  return { load, publishAndSave, flush, dispose };
}
