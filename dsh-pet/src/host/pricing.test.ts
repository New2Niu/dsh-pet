/**
 * 单轮花费折算的单元测试：价目只对认得出的服务商/模型生效，金额按峰谷两档算，格式适合几厘钱的量级。
 *
 * 这三件事都是「错一位就是假账」的地方：服务商门禁、峰谷切换、金额格式。
 * 跑法：node --experimental-strip-types --test src/host/pricing.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { addUsage, formatTurnCost, modelPriceOf, turnCostOf, turnCostText } from './pricing.ts';

/** 周六中午：全天空闲价。 */
const idleAt = new Date('2026-10-31T12:00:00+08:00');
/** 周一 10:00（北京时间）：高峰价。 */
const peakAt = new Date('2026-11-02T10:00:00+08:00');

const flash = { provider: 'deepseek-official', model: 'deepseek-flash' };
const pro = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };

describe('modelPriceOf —— 只给认得出的服务商与模型定价', () => {
  test('DeepSeek Flash：空闲 / 高峰两档', () => {
    assert.deepEqual(modelPriceOf(flash, 'idle'), { hit: 0.02, miss: 1, out: 4 });
    assert.deepEqual(modelPriceOf(flash, 'peak'), { hit: 0.04, miss: 2, out: 8 });
  });

  test('DeepSeek Pro：空闲 / 高峰两档', () => {
    assert.deepEqual(modelPriceOf(pro, 'idle'), { hit: 0.15, miss: 4.5, out: 13.5 });
    assert.deepEqual(modelPriceOf(pro, 'peak'), { hit: 0.3, miss: 9, out: 27 });
  });

  test('旧名与变体按同一档价：deepseek-v4-flash / vision-exp 都走 Flash', () => {
    assert.deepEqual(
      modelPriceOf({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }, 'idle'),
      modelPriceOf(flash, 'idle'),
    );
  });

  test('别家也有叫 flash / pro 的型号：不套 DeepSeek 的价目', () => {
    assert.equal(modelPriceOf({ provider: 'opencode', model: 'gemini-flash' }, 'idle'), undefined);
    assert.equal(modelPriceOf({ provider: 'commandcode', model: 'some-pro' }, 'idle'), undefined);
  });

  test('认不出的 DeepSeek 型号不猜价：老模型名没有现行价目', () => {
    assert.equal(modelPriceOf({ provider: 'deepseek-official', model: 'deepseek-chat' }, 'idle'), undefined);
  });
});

describe('turnCostOf —— 按 token 用量折算（元 / 百万 token）', () => {
  test('一百万未命中输入：空闲 1 元、高峰 2 元', () => {
    const counts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
    assert.equal(turnCostOf(counts, flash, idleAt), 1);
    assert.equal(turnCostOf(counts, flash, peakAt), 2);
  });

  test('缓存命中单独计价（比未命中便宜 50 倍）', () => {
    assert.equal(turnCostOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, flash, idleAt), 0.02);
  });

  test('真实一轮的形状：命中远大于未命中，金额落在几厘钱', () => {
    // 取自本机真实会话的一条 usage：input 1028（未命中）/ cacheRead 20352 / output 155。
    const cost = turnCostOf({ inputTokens: 1028, outputTokens: 155, cacheReadTokens: 20352 }, flash, idleAt);
    assert.ok(cost !== undefined);
    // 1028×1 + 20352×0.02 + 155×4 = 2055.04（÷1e6）
    assert.ok(Math.abs(cost - 0.00205504) < 1e-12, '实际算得 ' + String(cost));
  });

  test('Pro 与 Flash 同用量不同价：Pro 是 Flash 的 4.5 倍', () => {
    const counts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
    assert.equal(turnCostOf(counts, pro, idleAt), 4.5);
  });

  test('没有用量 / 认不出价目 → undefined（不报 0 元）', () => {
    assert.equal(turnCostOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, flash, idleAt), undefined);
    assert.equal(
      turnCostOf({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 }, { provider: 'x', model: 'y' }),
      undefined,
    );
  });
});

describe('formatTurnCost —— 几厘钱的量级也要看得见', () => {
  test('小额保留有效位，去尾零但至少两位小数', () => {
    assert.equal(formatTurnCost(0.0020551), '¥0.0021');
    assert.equal(formatTurnCost(0.02), '¥0.02');
    assert.equal(formatTurnCost(1.5), '¥1.50');
    assert.equal(formatTurnCost(12.3456), '¥12.3456');
    assert.equal(formatTurnCost(0), '¥0.00');
  });

  test('非法输入兜底成 0，不吐 NaN', () => {
    assert.equal(formatTurnCost(Number.NaN), '¥0.00');
    assert.equal(formatTurnCost(-1), '¥0.00');
  });
});

describe('addUsage —— 跨 step 求和', () => {
  test('逐步累加，缺字段按 0', () => {
    const first = addUsage(undefined, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 });
    assert.deepEqual(first, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 });
    const second = addUsage(first, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 900 });
    assert.deepEqual(second, { inputTokens: 150, outputTokens: 15, cacheReadTokens: 900 });
  });

  test('坏形状不污染累计：原样返回上一次的值', () => {
    const base = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 };
    assert.deepEqual(addUsage(base, undefined), base);
    assert.deepEqual(addUsage(base, 'nope'), base);
    assert.deepEqual(addUsage(base, {}), base, '一项都没有 → 不算一次观测');
    assert.deepEqual(addUsage(base, { inputTokens: -5, outputTokens: 'x' }), base);
  });
});

describe('turnCostText —— 直接给气泡用的文本', () => {
  test('有价目有量 → ¥ 文本；否则 undefined', () => {
    const counts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
    assert.equal(turnCostText(counts, flash, idleAt), '¥1.00');
    assert.equal(turnCostText(counts, { provider: 'opencode', model: 'gemini-flash' }, idleAt), undefined);
    assert.equal(turnCostText({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, flash, idleAt), undefined);
  });
});
