/**
 * 单轮花费折算：把 DSH 记录的一轮 token 用量按官方价目折成人民币。
 *
 * 不负责取用量（归 plugin/session-watch 从 `assistant/message` 事件累积），也不负责展示（归 shared/work-status）。
 * 价目表是本模块唯一的业务知识：官方调价后只改这里，调用方一行不动。
 * 始终成立：只给认得价的服务商/模型算钱——认不出就返回 undefined，气泡少一句，绝不报一个编出来的金额。
 *
 * 价目来源：DeepSeek 官方「模型 & 价格」（2026-08-17 起峰谷计价，单位：元 / 百万 token）。
 * 高峰 = 北京时间工作日 9:00–12:00、14:00–18:00，其余（含周末与法定节假日）为空闲，空闲价是高峰的一半；
 * 峰谷判定与余额气泡上的「峰/谷」同一个函数（balance/deepseek-common），不另写一套。
 *
 * @module dsh-pet/src/host/pricing
 */
import { deepseekPricingTier } from './balance/deepseek-common.ts';

/** 一轮对话的 token 用量（跨该轮所有 step 求和）。 */
export interface TurnTokenCounts {
  /** 输入·缓存未命中：DSH 的 inputTokens 就是未命中部分（与 totalTokens = input + output + cacheRead 自洽）。 */
  inputTokens: number;
  /** 输出 token（含推理输出）。 */
  outputTokens: number;
  /** 输入·缓存命中。 */
  cacheReadTokens: number;
}

/** 某模型在某计价时段的单价（元 / 百万 token）。 */
export interface ModelPrice {
  /** 缓存命中输入 */
  hit: number;
  /** 缓存未命中输入 */
  miss: number;
  /** 输出 */
  out: number;
}

/** 计价时段：沿用余额侧的两档口径。 */
type PriceTier = 'peak' | 'idle';

/** DeepSeek Flash（deepseek-flash / 旧名 deepseek-v4-flash）。 */
const DEEPSEEK_FLASH: Record<PriceTier, ModelPrice> = {
  idle: { hit: 0.02, miss: 1, out: 4 },
  peak: { hit: 0.04, miss: 2, out: 8 },
};

/** DeepSeek Pro（deepseek-v4-pro）。 */
const DEEPSEEK_PRO: Record<PriceTier, ModelPrice> = {
  idle: { hit: 0.15, miss: 4.5, out: 13.5 },
  peak: { hit: 0.3, miss: 9, out: 27 },
};

/** 计价所需的模型标识（= `agentDefaultModel.currentSelection()` 的两个字段）。 */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * 取某模型的单价；不认得就返回 undefined。
 *
 * 先卡服务商再认模型：别家也有叫 flash / pro 的型号，按名字直接套 DeepSeek 的价目会算出一个假数字。
 */
export function modelPriceOf(ref: ModelRef, tier: PriceTier): ModelPrice | undefined {
  if (!ref.provider.toLowerCase().includes('deepseek')) return undefined;
  const id = ref.model.toLowerCase();
  if (id.includes('flash')) return DEEPSEEK_FLASH[tier];
  if (id.includes('pro')) return DEEPSEEK_PRO[tier];
  return undefined;
}

/**
 * 一轮对话的花费（元）。
 *
 * @param counts - 该轮累计用量。
 * @param ref - 该轮用的模型；认不出价目时返回 undefined。
 * @param now - 结算时刻，用来判断峰谷（一轮跨过峰谷边界时按结束时刻算，误差只影响这一轮的分角）。
 * @returns 金额（元）；没有可计价的用量或认不出价目时为 undefined。
 */
export function turnCostOf(counts: TurnTokenCounts, ref: ModelRef, now: Date = new Date()): number | undefined {
  const miss = Math.max(0, counts.inputTokens);
  const hit = Math.max(0, counts.cacheReadTokens);
  const out = Math.max(0, counts.outputTokens);
  if (miss + hit + out <= 0) return undefined;
  const price = modelPriceOf(ref, deepseekPricingTier(now));
  if (!price) return undefined;
  return (miss * price.miss + hit * price.hit + out * price.out) / 1_000_000;
}

/**
 * 金额 → 展示文本（人民币）。
 *
 * 一轮对话通常只有几厘钱，两位小数会全变成 ¥0.00，所以按量级留位数：≥1 元两位、否则最多四位，
 * 再去掉多余的零（¥0.0200 → ¥0.02），至少保留两位小数。
 */
export function formatTurnCost(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '¥0.00';
  const [int, frac = ''] = amount.toFixed(4).split('.');
  const kept = frac.replace(/0+$/, '');
  // 至少两位小数：1.5 → 1.50、0.02 → 0.02，而 0.0021 原样保留四位。
  return '¥' + int + '.' + (kept.length >= 2 ? kept : (kept + '00').slice(0, 2));
}

/**
 * 一轮对话的花费文本（`¥0.0021`）；认不出价目或没有用量时返回 undefined。
 *
 * @param counts - 该轮累计用量。
 * @param ref - 该轮用的模型。
 * @param now - 结算时刻。
 */
export function turnCostText(counts: TurnTokenCounts, ref: ModelRef, now: Date = new Date()): string | undefined {
  const amount = turnCostOf(counts, ref, now);
  return amount === undefined ? undefined : formatTurnCost(amount);
}

/**
 * 把一条 `assistant/message` 事件的 usage 并入累计；形状不对就原样返回（不猜测、不清零）。
 *
 * @param counts - 该轮已有的累计；undefined 表示这是第一步。
 * @param usage - 事件里的 `data.usage`（未知形状，逐字段校验）。
 * @returns 新的累计；usage 不可用时返回原值。
 */
export function addUsage(counts: TurnTokenCounts | undefined, usage: unknown): TurnTokenCounts | undefined {
  if (!usage || typeof usage !== 'object') return counts;
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown };
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const add = {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
  };
  if (add.inputTokens + add.outputTokens + add.cacheReadTokens <= 0) return counts;
  const base = counts ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  return {
    inputTokens: base.inputTokens + add.inputTokens,
    outputTokens: base.outputTokens + add.outputTokens,
    cacheReadTokens: base.cacheReadTokens + add.cacheReadTokens,
  };
}
