import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { BALANCE_CLICK_GAP_MS, requestBalanceRefresh, resetBalanceRefresh } from './balance-refresh.ts';

/** 真实 fetch 换成记账桩：只关心「有没有真的发请求」，不关心响应。 */
const originalFetch = globalThis.fetch;
const sent: string[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown) => {
    sent.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  sent.length = 0;
  resetBalanceRefresh();
});

test('点击第一次立刻请求一次，窗口内的后续点击不再打接口', () => {
  stubFetch();
  assert.equal(requestBalanceRefresh(1000), true);
  assert.equal(requestBalanceRefresh(1000 + 1), false, '连点不该每次都打接口');
  assert.equal(requestBalanceRefresh(1000 + BALANCE_CLICK_GAP_MS - 1), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? '', /\/balance$/, '走的是余额刷新动作端点');
});

test('过了节流窗口再点会重新请求', () => {
  stubFetch();
  assert.equal(requestBalanceRefresh(1000), true);
  assert.equal(requestBalanceRefresh(1000 + BALANCE_CLICK_GAP_MS), true);
  assert.equal(sent.length, 2);
});

test('从未请求过时，第一下一定放行（时钟从 0 起算也一样）', () => {
  stubFetch();
  assert.equal(requestBalanceRefresh(0), true);
  assert.equal(requestBalanceRefresh(0), false, '同一时刻的第二下要被拦下');
  assert.equal(sent.length, 1);
});
