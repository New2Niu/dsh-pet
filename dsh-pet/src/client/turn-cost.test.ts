/**
 * 对话界面「本轮花费」的契约测试 —— 钉住三件容易错的事：
 *   ① 账本解析：坏数据只丢那一条，不能把 `[object Object]` 画到对话里；
 *   ② 匹配：金额按「会话 + 轮次」对上号，对不上就不显示（绝不错贴到别的会话）；
 *   ③ 落点：渲染成 turnTail 插槽里的一行小字（`本轮 ¥0.0021`），没金额时返回 null 不占位。
 *
 * 不引 jsdom / react：h 只记录 `{ type, props }`，hooks 用最小替身（useState 存一份值并记录
 * setter 调用，useEffect 立即执行）。这样测的是本模块的判断，不掺框架行为。
 *
 * 跑法：node --experimental-strip-types --test src/client/turn-cost.test.ts
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeTurnCostTail, pickTurnCost, readTurnCosts, turnCostOf, type TurnCostTailDeps } from './turn-cost.ts';
import { resetStateSnapshot, setStateSnapshot } from './state-service.ts';
import type { PollState } from '../shared/state.ts';

/** 一拍 /state：只关心 `sections.turnCost`，其余留空。 */
function snapshotWith(data: unknown): PollState {
  return { sections: { turnCost: { counter: 1, data } }, pets: {} };
}

/** 渲染出的一次元素：h 的替身产物。 */
interface El {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

/** 最小 hooks 替身：记下 state 变化便于断言「订阅后来值也刷进来」。 */
function makeDeps(): { deps: TurnCostTailDeps; writes: unknown[] } {
  const writes: unknown[] = [];
  let value: unknown;
  let ready = false;
  const deps: TurnCostTailDeps = {
    h: (type, props) => ({ type, props: props ?? {} }),
    useState: <T>(init: T | (() => T)) => {
      if (!ready) {
        value = typeof init === 'function' ? (init as () => T)() : init;
        ready = true;
      }
      const set = (next: T): void => {
        value = next;
        writes.push(next);
      };
      return [value as T, set] as [T, (next: T) => void];
    },
    // 立即执行副作用，清理函数丢掉：退订交给 beforeEach 的 resetStateSnapshot。
    useEffect: (effect) => {
      effect();
    },
    t: (key) => key,
  };
  return { deps, writes };
}

beforeEach(() => {
  resetStateSnapshot();
});

describe('readTurnCosts —— 叶子解析', () => {
  test('正常账本原样读出', () => {
    assert.deepEqual(readTurnCosts({ s1: { '3': '¥0.0021', '4': '¥1.50' } }), {
      s1: { '3': '¥0.0021', '4': '¥1.50' },
    });
  });

  test('坏条目逐条丢弃：非对象、空轮次、空金额、非字符串', () => {
    assert.deepEqual(
      readTurnCosts({
        s1: { '3': '¥0.0021', '': '¥1', '5': '', '6': 42, '7': null },
        s2: 'nope',
        s3: { '1': '¥2.00' },
      }),
      { s1: { '3': '¥0.0021' }, s3: { '1': '¥2.00' } },
    );
  });

  test('整份不是对象 / 是数组 / 会话为空 → 空账本', () => {
    assert.deepEqual(readTurnCosts(undefined), {});
    assert.deepEqual(readTurnCosts('x'), {});
    assert.deepEqual(readTurnCosts([]), {});
    assert.deepEqual(readTurnCosts({ s1: {} }), {}, '空会话不占位');
  });
});

describe('turnCostOf —— 会话 + 轮次对上号', () => {
  const map = { s1: { '3': '¥0.0021' } };

  test('数字与数字字符串都收（插槽给的是 number，账本的 key 是字符串）', () => {
    assert.equal(turnCostOf(map, 's1', 3), '¥0.0021');
    assert.equal(turnCostOf(map, 's1', '3'), '¥0.0021');
  });

  test('别的会话同号轮次 → 不匹配', () => {
    assert.equal(turnCostOf(map, 's2', 3), undefined);
  });

  test('缺会话 / 缺轮次 / 空串 → 不匹配', () => {
    assert.equal(turnCostOf(map, undefined, 3), undefined);
    assert.equal(turnCostOf(map, '', 3), undefined);
    assert.equal(turnCostOf(map, 's1', undefined), undefined);
    assert.equal(turnCostOf(map, 's1', ''), undefined);
  });

  test('pickTurnCost 从快照里取：没有快照就是没有', () => {
    assert.equal(pickTurnCost(null, 's1', 3), undefined);
    assert.equal(pickTurnCost(snapshotWith({ s1: { '3': '¥0.0021' } }), 's1', 3), '¥0.0021');
  });
});

describe('makeTurnCostTail —— turnTail 插槽里的一行小字', () => {
  test('对上号 → 「本轮」+ 金额，两个 span 都在', () => {
    setStateSnapshot(snapshotWith({ s1: { '3': '¥0.0021' } }));
    const { deps } = makeDeps();
    const tree = makeTurnCostTail(deps)({ turn: { turn: 3 }, sessionId: 's1' }) as El;
    assert.equal(tree.type, 'div');
    assert.equal(tree.props.className, 'dsh-pet-turn-cost');
    assert.equal(tree.props.title, 'cost.hint', '悬停说明走 title，不额外造浮层');
    const spans = tree.props.children as El[];
    assert.deepEqual(
      spans.map((span) => [span.props.className, span.props.children]),
      [
        ['dsh-pet-turn-cost-label', 'cost.label'],
        ['dsh-pet-turn-cost-amount', '¥0.0021'],
      ],
    );
  });

  test('账本里没有这一轮（旧轮次 / 认不出价目）→ null，不占位', () => {
    setStateSnapshot(snapshotWith({ s1: { '3': '¥0.0021' } }));
    const { deps } = makeDeps();
    assert.equal(makeTurnCostTail(deps)({ turn: { turn: 4 }, sessionId: 's1' }), null);
  });

  test('还没有 /state 快照 → null；不报错', () => {
    const { deps } = makeDeps();
    assert.equal(makeTurnCostTail(deps)({ turn: { turn: 3 }, sessionId: 's1' }), null);
  });

  test('轮次缺字段 → null', () => {
    setStateSnapshot(snapshotWith({ s1: { '3': '¥0.0021' } }));
    const { deps } = makeDeps();
    assert.equal(makeTurnCostTail(deps)({}), null);
    assert.equal(makeTurnCostTail(deps)({ sessionId: 's1' }), null);
    assert.equal(makeTurnCostTail(deps)({ turn: {}, sessionId: 's1' }), null);
  });

  test('账本后来才到 → 订阅回调把金额补上（不用等重新挂载）', () => {
    const { deps, writes } = makeDeps();
    makeTurnCostTail(deps)({ turn: { turn: 3 }, sessionId: 's1' });
    // 首帧那次写入与初值相同（都是 undefined），React 不会因此重渲染。
    assert.deepEqual(writes, [undefined]);
    setStateSnapshot(snapshotWith({ s1: { '3': '¥0.0021' } }));
    assert.deepEqual(writes, [undefined, '¥0.0021']);
  });

  test('后续每一拍都刷新；值没变时写的是同一个字符串（React 会跳过重渲染）', () => {
    setStateSnapshot(snapshotWith({ s1: { '3': '¥0.0021' } }));
    const { deps, writes } = makeDeps();
    makeTurnCostTail(deps)({ turn: { turn: 3 }, sessionId: 's1' });
    setStateSnapshot(snapshotWith({ s1: { '3': '¥0.0030' } }));
    assert.deepEqual(writes, ['¥0.0021', '¥0.0030']);
  });
});
