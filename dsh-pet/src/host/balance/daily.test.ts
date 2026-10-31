import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { balanceBubbleView, toBalanceState } from '../../shared/balance/index.ts';
import {
  BALANCE_DAILY_FILE_NAME,
  CARRY_OVER_MS,
  applyDailySpend,
  localDateKey,
  readDailyLedger,
  recordDailySpend,
} from './daily.ts';

/** 固定本地时间点：2026-10-31 10:00（本地时区，跨天断言不依赖 UTC）。 */
const NOW = new Date(2026, 9, 31, 10, 0, 0).getTime();

/** 空账本。 */
const empty = { date: localDateKey(NOW), providers: {} };

test('首次观测只记基线，不报今日已用', () => {
  const { ledger, today } = applyDailySpend(
    empty,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    NOW,
  );
  assert.deepEqual(today.items, [], '没有上一次读数就没法说「今天用了多少」');
  assert.equal(ledger.providers.p?.baseline.CNY, 10);
  assert.deepEqual(ledger.providers.p?.spent, {});
});

test('第二次观测的减少量累加进今日已用', () => {
  const first = applyDailySpend(empty, { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] }, NOW);
  const second = applyDailySpend(
    first.ledger,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 7.5 }] },
    NOW + 1000,
  );
  assert.deepEqual(second.today.items, [{ unit: 'CNY', amount: 2.5 }]);
  assert.equal(second.ledger.providers.p?.baseline.CNY, 7.5);
});

test('余额上升（充值）不计成负消费，只把基线抬上去', () => {
  let ledger = applyDailySpend(
    empty,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    NOW,
  ).ledger;
  ledger = applyDailySpend(
    ledger,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 8 }] },
    NOW + 1,
  ).ledger;
  const topped = applyDailySpend(
    ledger,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 50 }] },
    NOW + 2,
  );
  assert.deepEqual(topped.today.items, [{ unit: 'CNY', amount: 2 }], '充值不该把那 2 元抹掉，也不该变成负数');
  assert.equal(topped.ledger.providers.p?.baseline.CNY, 50, '充值后基线要跟着抬，否则下一笔消费会被算错');
});

test('同一单位零减少也是可信读数：今日已用 0', () => {
  const first = applyDailySpend(
    empty,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    NOW,
  ).ledger;
  const same = applyDailySpend(
    first,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    NOW + 1,
  );
  assert.deepEqual(same.today.items, [{ unit: 'CNY', amount: 0 }]);
  const later = applyDailySpend(
    same.ledger,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 9 }] },
    NOW + 2,
  );
  assert.deepEqual(later.today.items, [{ unit: 'CNY', amount: 1 }], '0 之后继续累加');
});

test('跨天清零，隔夜基线沿用（凌晨那一拍的花费算今天）', () => {
  // 昨晚 23:00 的读数 → 今天 00:30：中间只隔一晚，基线接得上。
  const lastNight = new Date(2026, 9, 31, 23, 0, 0).getTime();
  const nextDay = new Date(2026, 10, 1, 0, 30, 0).getTime();
  const yesterday = applyDailySpend(
    empty,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    lastNight,
  ).ledger;
  const first = applyDailySpend(
    yesterday,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 4 }] },
    nextDay,
  );
  assert.deepEqual(first.today.items, [{ unit: 'CNY', amount: 6 }], '零点是新的一天，累计从 0 起算');
  const again = applyDailySpend(
    first.ledger,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 3 }] },
    nextDay + 1000,
  );
  assert.deepEqual(again.today.items, [{ unit: 'CNY', amount: 7 }], '昨天的累计不会带到今天');
});

test('离上次观测太久（超过沿用窗口）就重新取基线，不把停机期间的花费算到今天', () => {
  const late = new Date(2026, 10, 3, 12, 0, 0).getTime();
  const old = applyDailySpend(
    empty,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 100 }] },
    NOW,
  ).ledger;
  assert.ok(late - NOW > CARRY_OVER_MS);
  const first = applyDailySpend(old, { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 40 }] }, late);
  assert.deepEqual(first.today.items, [], '断了太久，这次只能当基线');
  assert.equal(first.ledger.providers.p?.baseline.CNY, 40);
});

test('换服务商与换形态都另起一份账', () => {
  const money = applyDailySpend(
    empty,
    { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    NOW,
  ).ledger;
  const other = applyDailySpend(
    money,
    { provider: 'q', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] },
    NOW + 1,
  );
  assert.deepEqual(other.today.items, [], '另一个服务商的余额与 p 没有可比性');

  const points = applyDailySpend(
    money,
    { provider: 'p', shape: 'points', values: [{ unit: '积分', amount: 10 }] },
    NOW + 2,
  );
  assert.deepEqual(points.today.items, [], 'money 的余额与 points 的积分不能相减');
  assert.equal(points.ledger.providers.p?.shape, 'points');
});

test('非有限数跳过，不影响其它单位', () => {
  const first = applyDailySpend(
    empty,
    {
      provider: 'p',
      shape: 'money',
      values: [
        { unit: 'CNY', amount: 10 },
        { unit: 'USD', amount: 5 },
      ],
    },
    NOW,
  );
  const second = applyDailySpend(
    first.ledger,
    {
      provider: 'p',
      shape: 'money',
      values: [
        { unit: 'CNY', amount: Number.NaN },
        { unit: 'USD', amount: 4 },
      ],
    },
    NOW + 1,
  );
  assert.deepEqual(second.today.items, [{ unit: 'USD', amount: 1 }]);
  assert.equal(second.ledger.providers.p?.baseline.CNY, 10, '坏读数不该覆盖基线');
});

test('坏文件回落成空账本，不抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-daily-'));
  try {
    const file = join(dir, BALANCE_DAILY_FILE_NAME);
    writeFileSync(file, '{ 这不是 JSON');
    assert.deepEqual(readDailyLedger(file, NOW), { date: localDateKey(NOW), providers: {} });
    writeFileSync(file, JSON.stringify({ date: '2026-10-31', providers: { p: { shape: 'money' } } }));
    const parsed = readDailyLedger(file, NOW);
    assert.deepEqual(parsed.providers.p, { shape: 'money', baseline: {}, spent: {}, seenAt: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账落盘后再读回来能接上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-daily-'));
  try {
    const file = join(dir, BALANCE_DAILY_FILE_NAME);
    assert.deepEqual(
      recordDailySpend(file, { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 10 }] }, NOW),
      {
        date: localDateKey(NOW),
        items: [],
      },
    );
    const second = recordDailySpend(
      file,
      { provider: 'p', shape: 'money', values: [{ unit: 'CNY', amount: 6 }] },
      NOW + 60_000,
    );
    assert.deepEqual(second?.items, [{ unit: 'CNY', amount: 4 }]);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      providers: Record<string, { spent: Record<string, number> }>;
    };
    assert.equal(onDisk.providers.p?.spent.CNY, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记账结果按宿主写叶子的真实形状能被解析成「今日已用」一行（字段位置回归）', () => {
  // 这条用例是给一次真实事故留的：宿主把 today 写在结果顶层（与 data 平级），
  // 而解析层一度去 data.today 里找，于是记账明明成功了、气泡却永远少一行。
  // 这里按「宿主怎么写的」原样拼一个叶子，再从 shared 的解析入口读回来。
  const first = applyDailySpend(
    empty,
    { provider: 'deepseek-official', shape: 'money', values: [{ unit: 'CNY', amount: 20 }] },
    NOW,
  );
  const second = applyDailySpend(
    first.ledger,
    { provider: 'deepseek-official', shape: 'money', values: [{ unit: 'CNY', amount: 18.5 }] },
    NOW + 60_000,
  );
  // 与 balance-poll 的 withDailySpend 同形：{ ok, provider, shape, data, today }
  const leaf = {
    ok: true,
    provider: 'deepseek-official',
    shape: 'money',
    data: { wallets: [{ currency: 'CNY', total: '18.50', granted: '0.00', toppedUp: '18.50' }] },
    today: second.today,
  };
  const state = toBalanceState(leaf);
  assert.ok(state && state.ok);
  const rows = balanceBubbleView(state);
  const last = rows[rows.length - 1];
  assert.equal(last?.role, 'note');
  assert.equal(last?.text, '今日已用 ¥1.50');
});
