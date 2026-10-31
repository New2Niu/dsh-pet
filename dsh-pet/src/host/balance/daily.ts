/**
 * 今日已用的本地记账：每查到一次余额，就把「相对上一次读数的减少量」累加进当天。
 *
 * 不负责取数（归 ./index），也不负责展示（归 src/shared/balance）。
 * 服务商接口只回当前余额，没有「今日」口径；本地观测是唯一可得的事实，所以这份账只记
 * 观测到的减少量——充值（余额上升）不当成负消费，只把基线抬到新值。
 * 始终成立：没有上一次读数的单位不记账（宁可这一行不出现，也不报一个凭空来的 0）；
 * 跨天清零；离上一次观测超过 {@link CARRY_OVER_MS} 才查一次时重新取基线，不把停机期间的花费算进今天。
 *
 * @module dsh-pet/src/host/balance/daily
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoggerLike } from '../log-file.ts';
import type { DailySpend } from './types.ts';

/** 落盘文件名：与余额无关的展示无关，固定落在插件用户数据根下。 */
export const BALANCE_DAILY_FILE_NAME = 'balance-daily.json';

/** 跨天时基线最多沿用多久（ms）：隔夜（含凌晨那一拍）仍算连续观测；关机一天以上就重新取基线。 */
export const CARRY_OVER_MS = 12 * 60 * 60 * 1000;

/** 一次观测：某个服务商当前各单位的余额读数。 */
export interface DailySpendObservation {
  /** 命中的 provider id。 */
  provider: string;
  /** 可比的形态：只有金额与积分有「余额」可比，窗口百分比不在其中。 */
  shape: 'money' | 'points';
  /** 单位（币种或积分单位）→ 当前数值。 */
  values: { unit: string; amount: number }[];
}

/** 一个服务商当天的账。 */
export interface DailySpendProviderRecord {
  shape: 'money' | 'points';
  /** 上一次观测到的读数（单位 → 数值）。 */
  baseline: Record<string, number>;
  /** 今日累计的减少量（单位 → 正数）；有键即「今天这个单位至少观测过两次」。 */
  spent: Record<string, number>;
  /** 上一次观测时刻（ms）：跨天时用它与 {@link CARRY_OVER_MS} 判断基线还能不能沿用。 */
  seenAt: number;
}

/** 记账文件：一天一份，providers 下按服务商分开——换服务商时两份余额没有可比性。 */
export interface DailySpendLedger {
  /** 本地日期 YYYY-MM-DD；与今天不同即视为跨天。 */
  date: string;
  providers: Record<string, DailySpendProviderRecord>;
}

/** 本地日期键（YYYY-MM-DD）：按用户时区算，展示的「今日」与用户的今天一致。 */
export function localDateKey(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 空账本（首次运行或文件损坏时的起点）。 */
function emptyLedger(now: number): DailySpendLedger {
  return { date: localDateKey(now), providers: {} };
}

/** 读数是否可用于记账：非有限数（NaN / Infinity / 空串转出来的 0 要保留）一律跳过。 */
function usableAmount(amount: number): boolean {
  return Number.isFinite(amount);
}

/**
 * 把一次观测并入账本，返回新账本与本日累计。
 *
 * 纯函数：不读盘、不写盘，时间由调用方传入，便于脱开文件系统断言跨天、充值、换服务商这些分支。
 *
 * @param ledger - 现有账本；可以是空账本或上一次读盘的结果。
 * @param observation - 本次观测到的服务商与各单位读数。
 * @param now - 本次观测时刻（ms）。
 * @returns 新账本与本日累计（只有观测过至少两次的单位才进 items）。
 */
export function applyDailySpend(
  ledger: DailySpendLedger,
  observation: DailySpendObservation,
  now: number,
): { ledger: DailySpendLedger; today: DailySpend } {
  const date = localDateKey(now);
  // 跨天：清掉当天的累计，只保留还能接上的基线——隔夜的花费算今天的，关机几天的花费不算。
  let providers: Record<string, DailySpendProviderRecord> =
    ledger.date === date
      ? { ...ledger.providers }
      : Object.fromEntries(
          Object.entries(ledger.providers)
            .filter(([, record]) => now - record.seenAt <= CARRY_OVER_MS)
            .map(([provider, record]) => [provider, { ...record, spent: {} }]),
        );

  const previous = providers[observation.provider];
  // 形态换了就没法比：money 的「余额」与 points 的「积分」不是一回事，重取基线。
  const record: DailySpendProviderRecord =
    previous && previous.shape === observation.shape
      ? { ...previous, baseline: { ...previous.baseline }, spent: { ...previous.spent } }
      : { shape: observation.shape, baseline: {}, spent: {}, seenAt: now };

  for (const { unit, amount } of observation.values) {
    if (!usableAmount(amount)) continue;
    const before = record.baseline[unit];
    if (before === undefined || !usableAmount(before)) {
      // 首次见到这个单位：只能拿它当基线。这一拍不产生任何「已用」。
      record.baseline[unit] = amount;
      continue;
    }
    // 有基线 = 这个单位今天起就有得比：先落一个 0，零减少也是可信的读数。
    record.spent[unit] ??= 0;
    const delta = before - amount;
    // 只在减少时累计：余额上升是充值或赠送，不是「负消费」。
    if (delta > 0) record.spent[unit] += delta;
    record.baseline[unit] = amount;
  }
  record.seenAt = now;

  providers = { ...providers, [observation.provider]: record };

  const items = Object.entries(record.spent)
    .filter(([, amount]) => Number.isFinite(amount) && amount >= 0)
    .map(([unit, amount]) => ({ unit, amount }));

  return { ledger: { date, providers }, today: { date, items } };
}

/** 读账本：文件不存在、空文件、JSON 坏掉、结构不对都回落成空账本——记账失败不该影响余额本身。 */
export function readDailyLedger(file: string, now: number): DailySpendLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return emptyLedger(now);
  }
  if (!raw || typeof raw !== 'object') return emptyLedger(now);
  const data = raw as { date?: unknown; providers?: unknown };
  const date = typeof data.date === 'string' && data.date.length > 0 ? data.date : localDateKey(now);
  const providers: Record<string, DailySpendProviderRecord> = {};
  if (data.providers && typeof data.providers === 'object' && !Array.isArray(data.providers)) {
    for (const [provider, value] of Object.entries(data.providers as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as { shape?: unknown; baseline?: unknown; spent?: unknown; seenAt?: unknown };
      if (rec.shape !== 'money' && rec.shape !== 'points') continue;
      providers[provider] = {
        shape: rec.shape,
        baseline: numbersOf(rec.baseline),
        spent: numbersOf(rec.spent),
        seenAt: typeof rec.seenAt === 'number' && Number.isFinite(rec.seenAt) ? rec.seenAt : 0,
      };
    }
  }
  return { date, providers };
}

/** 把磁盘上的单位表收窄成 `单位 → 数值`；坏条目逐条丢弃，不整份作废。 */
function numbersOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [unit, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[unit] = value;
  }
  return out;
}

/** 写账本：先写临时文件再改名，进程中途退出不会留下半份 JSON。失败只告警，不打断余额刷新。 */
export function writeDailyLedger(file: string, ledger: DailySpendLedger, log?: LoggerLike): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(ledger), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    log?.warn?.('[dsh-pet] 今日已用记账失败：' + (e instanceof Error ? e.message : String(e)));
  }
}

/**
 * 记账一步到位：读盘 → 并入本次观测 → 写盘。
 *
 * @returns 本日累计；记账失败（读写异常）返回 undefined，调用方据此不带这一项。
 */
export function recordDailySpend(
  file: string,
  observation: DailySpendObservation,
  now: number,
  log?: LoggerLike,
): DailySpend | undefined {
  try {
    const { ledger, today } = applyDailySpend(readDailyLedger(file, now), observation, now);
    writeDailyLedger(file, ledger, log);
    return today;
  } catch (e) {
    log?.warn?.('[dsh-pet] 今日已用记账异常：' + (e instanceof Error ? e.message : String(e)));
    return undefined;
  }
}
