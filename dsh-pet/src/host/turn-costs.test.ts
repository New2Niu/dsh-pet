/**
 * 每轮花费账本的单元测试：记住每一轮的金额，同时保证它不会无限长大。
 *
 * 这个账本要塞进每秒一次的 /state，所以「上限」和「淘汰」是功能的一部分，不只是实现细节：
 * 丢掉太老的轮次、丢掉最久没写的会话，都不能把最近几轮的钱弄丢。
 * 跑法：node --experimental-strip-types --test src/host/turn-costs.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SESSIONS, MAX_TURNS_PER_SESSION, TurnCostStore } from './turn-costs.ts';

describe('TurnCostStore —— 记金额', () => {
  test('按会话 + 轮次记，快照是普通对象', () => {
    const store = new TurnCostStore();
    assert.equal(store.record('s1', '3', '¥0.0021'), true);
    assert.equal(store.record('s1', '4', '¥1.50'), true);
    assert.deepEqual(store.snapshot(), { s1: { '3': '¥0.0021', '4': '¥1.50' } });
  });

  test('同一轮重复结算：覆盖旧值，值没变就不算变化', () => {
    const store = new TurnCostStore();
    store.record('s1', '3', '¥0.0021');
    assert.equal(store.record('s1', '3', '¥0.0021'), false, '值没变 → 不必再写一拍 /state');
    assert.equal(store.record('s1', '3', '¥0.0030'), true);
    assert.deepEqual(store.snapshot(), { s1: { '3': '¥0.0030' } });
  });

  test('没有金额（认不出价目）→ 把该轮摘掉，不留过期数字', () => {
    const store = new TurnCostStore();
    store.record('s1', '3', '¥0.0021');
    assert.equal(store.record('s1', '3', null), true);
    assert.deepEqual(store.snapshot(), {});
  });

  test('本来就没记过、又报 null：不建空会话，也不算变化', () => {
    const store = new TurnCostStore();
    assert.equal(store.record('s1', '3', null), false);
    assert.deepEqual(store.snapshot(), {});
  });

  test('空会话 / 空轮次不写（防脏键撑大 /state）', () => {
    const store = new TurnCostStore();
    assert.equal(store.record('', '3', '¥0.1'), false);
    assert.equal(store.record('s1', '', '¥0.1'), false);
    assert.deepEqual(store.snapshot(), {});
  });

  test('clear 丢掉整个会话', () => {
    const store = new TurnCostStore();
    store.record('s1', '3', '¥0.1');
    store.record('s2', '1', '¥0.2');
    assert.equal(store.clear('s1'), true);
    assert.deepEqual(store.snapshot(), { s2: { '1': '¥0.2' } });
    assert.equal(store.clear('s1'), false);
  });
});

describe('TurnCostStore —— 有上限（塞进每秒 /state 的东西不能无限长）', () => {
  test('单会话超过轮次上限：从最早那轮开始丢，最近的都在', () => {
    const store = new TurnCostStore();
    for (let turn = 1; turn <= MAX_TURNS_PER_SESSION + 5; turn += 1) store.record('s1', String(turn), '¥0.1');
    const costs = store.snapshot().s1 ?? {};
    assert.equal(Object.keys(costs).length, MAX_TURNS_PER_SESSION);
    assert.equal(costs['1'], undefined, '最早的轮次被淘汰');
    assert.equal(costs[String(MAX_TURNS_PER_SESSION + 5)], '¥0.1', '最新的轮次还在');
  });

  test('会话数超过上限：淘汰最久没写入的那个', () => {
    const store = new TurnCostStore();
    for (let i = 1; i <= MAX_SESSIONS; i += 1) store.record('s' + i, '1', '¥0.1');
    // 再摸一下最早的 s1（刷新它的写入时刻），随后加入新会话 → 应该淘汰 s2 而不是 s1
    store.record('s1', '2', '¥0.2');
    store.record('s' + (MAX_SESSIONS + 1), '1', '¥0.3');
    const sessions = Object.keys(store.snapshot());
    assert.equal(sessions.length, MAX_SESSIONS);
    assert.ok(sessions.includes('s1'), '最近写过的会话要保留');
    assert.ok(!sessions.includes('s2'), '最久没写过的会话被淘汰');
  });
});
