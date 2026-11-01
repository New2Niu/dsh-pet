/**
 * 每轮花费账本持久化层的测试 —— 钉住三件「重启后还看得见」的前提：
 *   ① 载入：读回磁盘账本后要**补写一拍 /state**，否则前端首拍是空叶子；
 *   ② 节流：一轮一次文件写会把磁盘刷成筛子，窗口内的多次记账要合并成一次；
 *   ③ 收尾：卸载时挂起的窗口必须立刻写掉，最后一轮的钱不能丢。
 *
 * 用真文件（临时目录）+ 注入的读 / 写替身分别验证：前者测真落盘，后者数调用次数。
 * 跑法：node --experimental-strip-types --test src/host/plugin/turn-cost-persistence.test.ts
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTurnCostPersistence } from './turn-cost-persistence.ts';
import { TURN_COST_FILE_NAME } from './turn-cost-file.ts';
import { TurnCostStore, type TurnCostDiskMap } from '../turn-costs.ts';

/** 每个用例一个临时目录：互不干扰，也不碰真实用户数据。 */
let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-pet-turncost-'));
  file = join(dir, TURN_COST_FILE_NAME);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 收集告警的假 logger。 */
function makeLog(): { warns: string[]; log: { warn: (message: string) => void } } {
  const warns: string[] = [];
  return { warns, log: { warn: (message: string) => warns.push(message) } };
}

/** 睡一小会儿，等防抖窗口过去。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('load —— 启动时把磁盘账本读回来', () => {
  test('读回账本并补写一拍 /state（否则前端首拍还是空）', async () => {
    const { log } = makeLog();
    const at = Date.now();
    await writeFile(file, JSON.stringify({ v: 1, sessions: { s1: { at, costs: { '3': '¥0.0021' } } } }), 'utf8');

    const store = new TurnCostStore();
    const published: Record<string, Record<string, string>>[] = [];
    const persistence = createTurnCostPersistence({ file, log, store, publish: (costs) => published.push(costs) });
    await persistence.load();

    assert.deepEqual(store.snapshot(), { s1: { '3': '¥0.0021' } });
    assert.deepEqual(published, [{ s1: { '3': '¥0.0021' } }], '载入后要推一拍，前端才看得到旧金额');
    persistence.dispose();
  });

  test('文件不存在：不抛、不推 /state（就是还没有账）', async () => {
    const { log, warns } = makeLog();
    const store = new TurnCostStore();
    const published: unknown[] = [];
    const persistence = createTurnCostPersistence({ file, log, store, publish: (costs) => published.push(costs) });
    await persistence.load();
    assert.deepEqual(published, []);
    assert.deepEqual(warns, [], '文件没写过不算异常，不该刷告警');
    persistence.dispose();
  });

  test('文件损坏：只告警一次，按空账本继续跑', async () => {
    const { log, warns } = makeLog();
    await writeFile(file, '{ 这不是 JSON', 'utf8');
    const store = new TurnCostStore();
    const published: unknown[] = [];
    const persistence = createTurnCostPersistence({ file, log, store, publish: (costs) => published.push(costs) });
    await persistence.load();
    assert.deepEqual(published, []);
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? '', /读不出来/);
    persistence.dispose();
  });

  test('卸载后才回来的载入结果被丢弃（不覆盖已清空的账本）', async () => {
    const { log } = makeLog();
    await writeFile(
      file,
      JSON.stringify({ v: 1, sessions: { s1: { at: Date.now(), costs: { '3': '¥0.0021' } } } }),
      'utf8',
    );
    const store = new TurnCostStore();
    const published: unknown[] = [];
    let release: (value: unknown) => void = () => {};
    const persistence = createTurnCostPersistence({
      file,
      log,
      store,
      publish: (costs) => published.push(costs),
      read: () => new Promise((resolve) => (release = resolve)),
    });
    const loading = persistence.load();
    persistence.dispose();
    release({ s1: { at: Date.now(), costs: { '3': '¥0.0021' } } });
    await loading;
    assert.deepEqual(published, [], '已经卸载了，别再把金额推到 /state');
  });
});

describe('publishAndSave —— 先写 /state，再节流落盘', () => {
  test('载入还没完成时绝不写盘（否则会用空账本盖掉磁盘上的旧账）', async () => {
    const { log } = makeLog();
    const writes: TurnCostDiskMap[] = [];
    const store = new TurnCostStore();
    let release: (value: unknown) => void = () => {};
    const persistence = createTurnCostPersistence({
      file,
      log,
      store,
      publish: () => {},
      delayMs: 5,
      read: () => new Promise((resolve) => (release = resolve)),
      write: (_file, sessions) => {
        writes.push(sessions);
        return Promise.resolve();
      },
    });

    const loading = persistence.load();
    store.record('s1', '1', '¥0.01');
    persistence.publishAndSave(store.snapshot());
    await persistence.flush();
    await wait(20);
    assert.equal(writes.length, 0, '载入没回来之前写盘 = 覆盖几十天的账，必须挡住');

    release({ s9: { at: Date.now(), costs: { '5': '¥9.99' } } });
    await loading;
    await persistence.flush();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.s9?.costs, { '5': '¥9.99' }, '载入完成后写的是合并后的账');
    assert.deepEqual(writes[0]?.s1?.costs, { '1': '¥0.01' }, '载入窗口里记下的那一轮不能被丢掉');
    persistence.dispose();
  });

  test('publish 立刻发生；落盘要等窗口（不是每轮刷一次磁盘）', async () => {
    const { log } = makeLog();
    const store = new TurnCostStore();
    const writes: TurnCostDiskMap[] = [];
    const published: unknown[] = [];
    const persistence = createTurnCostPersistence({
      file,
      log,
      store,
      publish: (costs) => published.push(costs),
      delayMs: 30,
      write: (_file, sessions) => {
        writes.push(sessions);
        return Promise.resolve();
      },
    });

    // 载入跑完才允许写盘（否则会用空账本覆盖磁盘上的旧账）
    await persistence.load();

    store.record('s1', '3', '¥0.0021');
    persistence.publishAndSave(store.snapshot());
    assert.equal(published.length, 1, '/state 是给人看的，立刻写');
    assert.equal(writes.length, 0, '窗口没到，还没落盘');

    await wait(80);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.s1?.costs, { '3': '¥0.0021' });
    persistence.dispose();
  });

  test('窗口内的多次记账合并成一次写，且带的是最后一版内容', async () => {
    const { log } = makeLog();
    const store = new TurnCostStore();
    const writes: TurnCostDiskMap[] = [];
    const persistence = createTurnCostPersistence({
      file,
      log,
      store,
      publish: () => {},
      delayMs: 40,
      write: (_file, sessions) => {
        writes.push(sessions);
        return Promise.resolve();
      },
    });

    await persistence.load();

    for (const turn of ['1', '2', '3']) {
      store.record('s1', turn, '¥0.0' + turn);
      persistence.publishAndSave(store.snapshot());
      await wait(5);
    }
    await wait(90);
    assert.equal(writes.length, 1, '三轮只该落一次盘');
    assert.deepEqual(Object.keys(writes[0]?.s1?.costs ?? {}), ['1', '2', '3']);
    persistence.dispose();
  });
});

describe('flush / dispose —— 收尾不能丢最后一轮', () => {
  test('flush 立刻写，不等窗口', async () => {
    const { log } = makeLog();
    const store = new TurnCostStore();
    const writes: TurnCostDiskMap[] = [];
    const persistence = createTurnCostPersistence({
      file,
      log,
      store,
      publish: () => {},
      delayMs: 10_000,
      write: (_file, sessions) => {
        writes.push(sessions);
        return Promise.resolve();
      },
    });
    await persistence.load();
    store.record('s1', '7', '¥0.07');
    persistence.publishAndSave(store.snapshot());
    await persistence.flush();
    assert.equal(writes.length, 1);
    persistence.dispose();
    await wait(20);
    assert.equal(writes.length, 1, 'dispose 之后不该再补写一次');
  });

  test('dispose 会把挂起的窗口写掉', async () => {
    const { log } = makeLog();
    const store = new TurnCostStore();
    const writes: TurnCostDiskMap[] = [];
    const persistence = createTurnCostPersistence({
      file,
      log,
      store,
      publish: () => {},
      delayMs: 10_000,
      write: (_file, sessions) => {
        writes.push(sessions);
        return Promise.resolve();
      },
    });
    await persistence.load();
    store.record('s1', '8', '¥0.08');
    persistence.publishAndSave(store.snapshot());
    persistence.dispose();
    await wait(20);
    assert.equal(writes.length, 1, '卸载时最后一轮的钱也要留下');
    assert.deepEqual(writes[0]?.s1?.costs, { '8': '¥0.08' });
  });

  test('真落盘：round-trip 一致，且是原子写（写完后没有 .tmp 残留）', async () => {
    const { log } = makeLog();
    const store = new TurnCostStore();
    const persistence = createTurnCostPersistence({ file, log, store, publish: () => {}, delayMs: 10_000 });
    await persistence.load();
    store.record('s1', '3', '¥0.0021');
    store.record('s2', '1', '¥1.50');
    await persistence.flush();
    persistence.dispose();

    const raw = JSON.parse(await readFile(file, 'utf8')) as { v: number; sessions: TurnCostDiskMap };
    assert.equal(raw.v, 1, '写版本号，将来改格式才有依据');
    assert.deepEqual(raw.sessions.s1?.costs, { '3': '¥0.0021' });
    assert.deepEqual(raw.sessions.s2?.costs, { '1': '¥1.50' });
    assert.ok(typeof raw.sessions.s1?.at === 'number', 'at 要落盘：留存与淘汰都靠它');
    await assert.rejects(() => readFile(file + '.tmp', 'utf8'), '原子写不该留下临时文件');
  });
});
