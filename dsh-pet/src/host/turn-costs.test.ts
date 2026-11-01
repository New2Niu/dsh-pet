/**
 * 每轮花费账本的单元测试：记住每一轮的金额，同时保证它不会无限长大。
 *
 * 这个账本要塞进每秒一次的 /state，所以「上限」和「淘汰」是功能的一部分，不只是实现细节：
 * 丢掉太老的轮次、丢掉最久没写的会话，都不能把最近几轮的钱弄丢。
 * 跑法：node --experimental-strip-types --test src/host/turn-costs.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SESSIONS, MAX_TURNS_PER_SESSION, RETENTION_MS, TurnCostStore } from './turn-costs.ts';

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

describe('TurnCostStore —— 磁盘副本（dump / hydrate）', () => {
  test('dump 带上每个会话的 at，hydrate 原样还原', () => {
    const store = new TurnCostStore();
    store.record('s1', '3', '¥0.0021');
    store.record('s1', '4', '¥1.50');
    const dump = store.dump();
    assert.deepEqual(dump.s1?.costs, { '3': '¥0.0021', '4': '¥1.50' });
    assert.equal(typeof dump.s1?.at, 'number', '落盘要带写入时刻，淘汰与留存都靠它');

    const restored = new TurnCostStore();
    restored.hydrate(dump, dump.s1?.at);
    assert.deepEqual(restored.snapshot(), { s1: { '3': '¥0.0021', '4': '¥1.50' } });
  });

  test('坏数据逐条丢：非对象、空 costs、空轮次、空金额、非字符串', () => {
    const store = new TurnCostStore();
    const now = 1_000_000_000_000;
    store.hydrate(
      {
        good: { at: now, costs: { '3': '¥0.0021' } },
        noCosts: { at: now, costs: 'nope' },
        empty: { at: now, costs: {} },
        dirty: { at: now, costs: { '': '¥1', '5': '', '6': 42, '7': null } },
        scalar: 7,
      },
      now,
    );
    assert.deepEqual(store.snapshot(), { good: { '3': '¥0.0021' } });
  });

  test('非对象 / 数组 / null → 不动（保持空账本）', () => {
    for (const raw of [undefined, null, 7, 'x', [], true]) {
      const store = new TurnCostStore();
      store.hydrate(raw);
      assert.deepEqual(store.snapshot(), {});
    }
  });

  test('超过留存天数的会话在载入时丢掉，其余保留', () => {
    const now = 1_000_000_000_000;
    const store = new TurnCostStore();
    store.hydrate(
      {
        fresh: { at: now - 1000, costs: { '1': '¥0.1' } },
        stale: { at: now - RETENTION_MS - 1, costs: { '1': '¥0.2' } },
        // 刚过线一天都算过期：判定是「超过留存窗口」
        edge: { at: now - RETENTION_MS, costs: { '1': '¥0.3' } },
      },
      now,
    );
    assert.deepEqual(Object.keys(store.snapshot()).sort(), ['edge', 'fresh']);
  });

  test('at 缺失或坏掉按「刚写过」处理：不因为一个坏字段丢掉整份账', () => {
    const now = 1_000_000_000_000;
    const store = new TurnCostStore();
    store.hydrate({ s1: { costs: { '1': '¥0.1' } }, s2: { at: 'x', costs: { '1': '¥0.2' } } }, now);
    assert.deepEqual(store.snapshot(), { s1: { '1': '¥0.1' }, s2: { '1': '¥0.2' } });
  });

  test('会话数与每会话轮次在载入时就被裁到位', () => {
    const now = 1_000_000_000_000;
    const raw: Record<string, { at: number; costs: Record<string, string> }> = {};
    for (let i = 1; i <= MAX_SESSIONS + 3; i += 1) {
      raw['s' + i] = { at: now - (MAX_SESSIONS + 3 - i) * 1000, costs: { '1': '¥0.1' } };
    }
    const manyTurns: Record<string, string> = {};
    for (let turn = 1; turn <= MAX_TURNS_PER_SESSION + 5; turn += 1) manyTurns[String(turn)] = '¥0.1';
    raw.big = { at: now, costs: manyTurns };

    const store = new TurnCostStore();
    store.hydrate(raw, now);
    const sessions = store.snapshot();
    assert.equal(Object.keys(sessions).length, MAX_SESSIONS, '多出来的会话按 at 淘汰');
    assert.ok(!('s1' in sessions), '最老的会话先丢');
    assert.ok('big' in sessions, '最新的会话保留');
    const turns = Object.keys(sessions.big ?? {});
    assert.equal(turns.length, MAX_TURNS_PER_SESSION);
    assert.equal(turns.includes('1'), false, '最早的轮次被裁掉');
  });

  test('载入期间已经记进来的新一轮不会被磁盘上的旧账盖掉', () => {
    const now = 1_000_000_000_000;
    const store = new TurnCostStore();
    // 模拟「load 还在读文件时，这一轮已经结束并记账」
    store.record('s1', '9', '¥9.99');
    store.hydrate({ s1: { at: now - 5000, costs: { '3': '¥0.0021' } } }, now);
    assert.deepEqual(store.snapshot(), { s1: { '3': '¥0.0021', '9': '¥9.99' } });
  });
});
