/**
 * 工作状态叶子的解析与气泡文案：钉住「本轮花费」与「会话跳转」的读写契约。
 *
 * 解析只认字符串（空串按没有处理），拼句子两端共用 workBubbleText——金额已经由宿主格式化好，
 * 客户端只负责接在任务详情后面；sessionId 供点气泡跳会话，老宿主不写、外部槽写 null。
 * 跑法：node --experimental-strip-types --test src/shared/work-status.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { toWorkStatus, workBubbleText } from './work-status.ts';

describe('toWorkStatus —— cost 字段', () => {
  test('有金额就带出来', () => {
    assert.deepEqual(toWorkStatus({ state: 'success', task: '改好了', cost: '¥0.0021' }), {
      state: 'success',
      task: '改好了',
      cost: '¥0.0021',
      sessionId: null,
    });
  });

  test('缺省 / 空串 / 非字符串都当作没有（不在气泡上留半句）', () => {
    for (const cost of [undefined, null, '', 3, {}, []]) {
      assert.equal(toWorkStatus({ state: 'success', task: null, cost })?.cost, null, String(cost));
    }
  });

  test('形状非法 → null，整拍跳过', () => {
    assert.equal(toWorkStatus('nope'), null);
    assert.equal(toWorkStatus(null), null);
  });
});

describe('toWorkStatus —— sessionId 解析', () => {
  test('带 sessionId → 原样保留，供点气泡跳会话', () => {
    const snap = toWorkStatus({ state: 'working', task: '改文件', sessionId: 'session-abc' });
    assert.equal(snap?.sessionId, 'session-abc');
  });

  test('缺字段 / null（老宿主或外部槽）→ null，气泡因此不可点', () => {
    assert.equal(toWorkStatus({ state: 'working', task: null })?.sessionId, null);
    assert.equal(toWorkStatus({ state: 'working', task: null, sessionId: null })?.sessionId, null);
  });

  test('空串 / 哨兵 unknown / 非字符串 → null（不让气泡跳到不存在的地方）', () => {
    for (const sessionId of ['', 'unknown', 42, {}, true]) {
      assert.equal(toWorkStatus({ state: 'working', task: null, sessionId })?.sessionId, null, String(sessionId));
    }
  });

  test('空闲快照也带 sessionId: null', () => {
    assert.deepEqual(toWorkStatus({ state: null, task: null }), {
      state: null,
      task: null,
      cost: null,
      sessionId: null,
    });
  });
});

describe('workBubbleText —— 任务详情 + 本轮花费', () => {
  test('两者都有：中间用「·」隔开', () => {
    assert.equal(workBubbleText('改好了 index.ts', '¥0.0021'), '改好了 index.ts · 本轮 ¥0.0021');
  });

  test('只有金额：不留下孤零零的分隔符', () => {
    assert.equal(workBubbleText(null, '¥0.0021'), '本轮 ¥0.0021');
  });

  test('只有文案（非终态 / 认不出价目）：原样返回', () => {
    assert.equal(workBubbleText('正在翻文件', null), '正在翻文件');
  });

  test('两者都没有：null，只播动画不弹气泡', () => {
    assert.equal(workBubbleText(null, null), null);
  });
});
