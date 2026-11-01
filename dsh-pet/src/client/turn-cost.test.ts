/**
 * 对话界面「本轮花费」补丁的契约测试 —— 钉住两件容易错的事：
 *   ① 账本解析：坏数据只丢那一条，不能把 `[object Object]` 画到对话里；
 *   ② 落点与匹配：金额按「会话 + 轮次」对上号，打在用量徽标容器上（`::after` 才落在用量右侧），
 *      没金额/对不上号/没有徽标（DSH 关掉详细用量）时一律不碰 DOM。
 *
 * 假 DOM 只实现本模块用到的那几个成员（不引 jsdom）：选择器支持 `tag`、`[attr]`、`[attr="v"]`。
 *
 * 跑法：node --experimental-strip-types --test src/client/turn-cost.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { COST_MARK, paintTurnCosts, readTurnCosts } from './turn-cost.ts';

/** 极简元素替身：只保留属性、父子关系与三种选择器能力。 */
class El {
  readonly tag: string;
  readonly attrs = new Map<string, string>();
  readonly children: El[] = [];
  parent: El | null = null;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
  }

  get parentElement(): El | null {
    return this.parent;
  }

  append(...kids: El[]): El {
    for (const kid of kids) {
      kid.parent = this;
      this.children.push(kid);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  closest(selector: string): El | null {
    if (matches(this, selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  querySelector(selector: string): El | null {
    return this.descendants().find((el) => matches(el, selector)) ?? null;
  }

  querySelectorAll(selector: string): El[] {
    return this.descendants().filter((el) => matches(el, selector));
  }

  private descendants(): El[] {
    const out: El[] = [];
    for (const kid of this.children) {
      out.push(kid, ...kid.descendants());
    }
    return out;
  }
}

/** `tag` / `[attr]` / `[attr="v"]` / `tag[attr="v"]` 四种形态。 */
function matches(el: El, selector: string): boolean {
  const parsed = /^([a-z0-9]*)((?:\[[^\]]+\])*)$/i.exec(selector);
  if (parsed === null) return false;
  const [, tag, attrPart] = parsed;
  if (tag !== undefined && tag !== '' && el.tag.toLowerCase() !== tag.toLowerCase()) return false;
  for (const attr of (attrPart ?? '').matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/gi)) {
    const name = attr[1] ?? '';
    const value = attr[2];
    if (!el.hasAttribute(name)) return false;
    if (value !== undefined && el.getAttribute(name) !== value) return false;
  }
  return true;
}

/** 假 document：只管 `querySelectorAll`。 */
function fakeDoc(root: El): Document {
  return { querySelectorAll: (selector: string) => root.querySelectorAll(selector) } as unknown as Document;
}

/** 造一轮：会话容器 > 轮尾容器 > 操作行 > 用量徽标容器 >（按钮）。 */
function buildTurn(options: { session?: string | null; turn: string; withUsage?: boolean }): {
  root: El;
  panel: El | null;
} {
  const root = new El('div');
  // session 为 null = 故意造一个不在会话容器里的轮尾（模拟 DSH 结构变化）。
  let host = root;
  if (options.session !== null) {
    host = new El('div', { 'data-conversation-session': options.session ?? 's1' });
    root.append(host);
  }
  const row = new El('div', { 'data-turn-tail': options.turn }).append(new El('div'));
  host.append(row);
  if (options.withUsage === false) return { root, panel: null };
  const panel = new El('span').append(new El('button', { 'aria-haspopup': 'dialog' }));
  row.children[0]?.append(panel);
  return { root, panel };
}

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

  test('整份不是对象 / 是数组 → 空账本', () => {
    assert.deepEqual(readTurnCosts(undefined), {});
    assert.deepEqual(readTurnCosts('x'), {});
    assert.deepEqual(readTurnCosts([]), {});
    assert.deepEqual(readTurnCosts({ s1: {} }), {}, '空会话不占位');
  });
});

describe('paintTurnCosts —— 金额落在用量徽标上', () => {
  test('按「会话 + 轮次」对上号：标记打在徽标容器，值与账本一致', () => {
    const { root, panel } = buildTurn({ session: 's1', turn: '3' });
    paintTurnCosts(fakeDoc(root), { s1: { '3': '¥0.0021' } });
    assert.equal(panel?.getAttribute(COST_MARK), '¥0.0021');
  });

  test('会话对不上号（另一个会话的同号轮次）→ 不标', () => {
    const { root, panel } = buildTurn({ session: 's2', turn: '3' });
    paintTurnCosts(fakeDoc(root), { s1: { '3': '¥0.0021' } });
    assert.equal(panel?.hasAttribute(COST_MARK), false);
  });

  test('账本里没有这一轮（旧轮次 / 认不出价目）→ 摘掉旧标记，不留过期金额', () => {
    const { root, panel } = buildTurn({ session: 's1', turn: '3' });
    paintTurnCosts(fakeDoc(root), { s1: { '3': '¥0.0021' } });
    paintTurnCosts(fakeDoc(root), { s1: {} });
    assert.equal(panel?.hasAttribute(COST_MARK), false);
  });

  test('金额变了 → 覆盖成新值', () => {
    const { root, panel } = buildTurn({ session: 's1', turn: '3' });
    paintTurnCosts(fakeDoc(root), { s1: { '3': '¥0.0021' } });
    paintTurnCosts(fakeDoc(root), { s1: { '3': '¥0.0030' } });
    assert.equal(panel?.getAttribute(COST_MARK), '¥0.0030');
  });

  test('没有用量徽标（DSH 未开启详细用量）→ 什么都不做，不报错', () => {
    const { root } = buildTurn({ session: 's1', turn: '3', withUsage: false });
    paintTurnCosts(fakeDoc(root), { s1: { '3': '¥0.0021' } });
    assert.equal(root.querySelectorAll('[' + COST_MARK + ']').length, 0);
  });

  test('不在会话容器里（结构变了）→ 跳过，不误标', () => {
    const { root, panel } = buildTurn({ session: null, turn: '3' });
    paintTurnCosts(fakeDoc(root), { '': { '3': '¥0.0021' } });
    assert.equal(panel?.hasAttribute(COST_MARK), false);
  });
});
