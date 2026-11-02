/**
 * 气泡停留时长（src/shared/config.ts 的 DEFAULT_BUBBLE_DURATION_SEC / isValidBubbleDurationSec /
 * bubbleDurationMs）的契约测试。
 *
 * 这里钉住的是两端共用的那一份换算：浏览器三个计时器与桌面 Helper 四个计时器都只调 bubbleDurationMs，
 * 它一旦返回 0 或负数，气泡就会「弹出即收起」或计时器直接抛错——都属于肉眼难查的静默故障。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUBBLE_DURATION_SEC_MAX,
  BUBBLE_DURATION_SEC_MIN,
  DEFAULT_BUBBLE_DURATION_SEC,
  bubbleDurationMs,
  isValidBubbleDurationSec,
} from './config.ts';

describe('isValidBubbleDurationSec —— 取值域', () => {
  test('区间端点与中间值合法', () => {
    for (const v of [BUBBLE_DURATION_SEC_MIN, 8, 15, 30, BUBBLE_DURATION_SEC_MAX]) {
      assert.equal(isValidBubbleDurationSec(v), true, `${v} 应合法`);
    }
  });

  test('字符串数字照收（手写 JSONC 写成带引号不该整段判非法）', () => {
    assert.equal(isValidBubbleDurationSec('15'), true);
  });

  test('0 / 越界 / 小数 / 脏值一律非法', () => {
    for (const v of [
      0,
      -1,
      -0.5,
      BUBBLE_DURATION_SEC_MAX + 1,
      1.5,
      NaN,
      Infinity,
      '',
      'abc',
      null,
      undefined,
      {},
      [],
    ]) {
      assert.equal(isValidBubbleDurationSec(v), false, `${JSON.stringify(v)} 应非法`);
    }
  });
});

describe('bubbleDurationMs —— 秒转毫秒，缺省/非法回落默认', () => {
  test('缺省与各种非法值都回到默认秒数', () => {
    const fallback = DEFAULT_BUBBLE_DURATION_SEC * 1000;
    for (const v of [undefined, null, 0, -3, 1.2, 'abc', NaN, {}, BUBBLE_DURATION_SEC_MAX + 1]) {
      assert.equal(bubbleDurationMs(v), fallback, `${JSON.stringify(v)} 应回落默认`);
    }
  });

  test('合法值原样换算成毫秒', () => {
    assert.equal(bubbleDurationMs(1), 1000);
    assert.equal(bubbleDurationMs(8), 8000);
    assert.equal(bubbleDurationMs('30'), 30000);
    assert.equal(bubbleDurationMs(BUBBLE_DURATION_SEC_MAX), BUBBLE_DURATION_SEC_MAX * 1000);
  });

  test('永远返回正数：调用方可以直接喂 setTimeout', () => {
    for (const v of [undefined, 0, -1, 1.5]) {
      assert.ok(bubbleDurationMs(v) > 0);
    }
  });
});
