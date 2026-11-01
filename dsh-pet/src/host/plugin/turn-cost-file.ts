/**
 * 每轮花费账本的磁盘副本：单个 JSON 文件的读与原子写。
 *
 * 只做「文件 ↔ 数据」，不校验业务形状（校验与裁剪归 ../turn-costs 的 hydrate），
 * 也不管什么时候写（节流与时机归 ./turn-cost-persistence）。
 *
 * 写失败只记日志不抛：账本落不了盘是遗憾，不是错误——绝不该让一次磁盘问题把会话事件处理打断。
 * 读失败同理：文件不存在 = 还没写过；解析失败 = 当成空账本继续跑（不备份、不改写源文件）。
 *
 * @module dsh-pet/src/host/plugin/turn-cost-file
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TurnCostDiskMap } from '../turn-costs.ts';
import type { LoggerLike } from '../log-file.ts';

/** 账本文件名：落在插件用户数据目录下（与 todos.json / memory.json 同一个根）。 */
export const TURN_COST_FILE_NAME = 'turn-costs.json';

/**
 * 文件格式版本。
 *
 * 目前只有 v1，读取时不按版本分支——形状交给 hydrate 逐层校验，认不出的字段自然被丢掉。
 * 将来真要改字段语义时，用这个字段决定怎么读，别猜。
 */
export const TURN_COST_FILE_VERSION = 1;

/** 磁盘上的文件形状。 */
interface TurnCostFile {
  v: number;
  sessions: TurnCostDiskMap;
}

/** 异常 → 一行可读原因（只进日志）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读账本文件。
 *
 * @param file - 账本文件绝对路径。
 * @param log - 告警出口。
 * @returns 文件里的 `sessions` 原始值（未经业务校验）；文件不存在或读不出来时 null。
 */
export async function readTurnCostFile(file: string, log: LoggerLike): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null; // 文件不存在 = 还没有账，不是错误
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('根不是对象');
    return (parsed as { sessions?: unknown }).sessions ?? null;
  } catch (error) {
    log.warn?.('[dsh-pet] 每轮花费账本读不出来，按空账本继续：' + messageOf(error));
    return null;
  }
}

/**
 * 原子写账本文件（先写 `.tmp` 再 rename，半份文件永远不会顶替好文件）。
 *
 * @param file - 账本文件绝对路径；父目录不存在时自动创建。
 * @param sessions - 要写的账本（来自 `TurnCostStore.dump()`）。
 * @param log - 告警出口。
 */
export async function writeTurnCostFile(file: string, sessions: TurnCostDiskMap, log: LoggerLike): Promise<void> {
  const body: TurnCostFile = { v: TURN_COST_FILE_VERSION, sessions };
  const tmp = file + '.tmp';
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(body), 'utf8');
    await rename(tmp, file);
  } catch (error) {
    log.warn?.('[dsh-pet] 每轮花费账本写不进去（本次跳过，下次变化再试）：' + messageOf(error));
  }
}
