/**
 * 全局开关卡（src/client/settings/global-card.ts）的契约测试。
 *
 * 三条契约：
 *   1. 五个开关的勾选态来自 `values`，切换回传的是配置字段名（键名错位会静默写坏别的开关）；
 *   2. 气泡停留时长是一个数字框，失焦提交回秒数（不是布尔，也不该跟开关混在同一排）；
 *   3. 忙时全部控件禁用，一次切换只回调一次。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { makeGlobalCard, type GlobalFlags } from './global-card.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
const GlobalCard = makeGlobalCard({ h, t: (key: string) => key } as never);

function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

const allOff: GlobalFlags = {
  notificationsEnabled: false,
  notifyWhenFocused: false,
  clickSoundEnabled: false,
  confineToScreen: false,
  trayEnabled: false,
};

/** 卡里全部 `<input>`。 */
const inputs = (tree: unknown): Node[] => flatten(tree).filter((node) => node.tag === 'input');

/** 五个勾选框，顺序即展示顺序。 */
const boxes = (tree: unknown): Node[] => inputs(tree).filter((node) => node.props.type === 'checkbox');

/** 气泡停留的秒数输入框（卡里唯一的数字框）。 */
const durationBox = (tree: unknown): Node => inputs(tree).find((node) => node.props.type === 'number') as Node;

/** 一次「改了数字再失焦」：走 numberInputProps 的提交口径。 */
const commitNumber = (box: Node, text: string): void => {
  const target = { value: text };
  (box.props.onBlur as (e: { target: { value: string } }) => void)({ target });
};

describe('GlobalCard —— 全局开关卡', () => {
  test('五个开关都在，勾选态来自 values', () => {
    const tree = GlobalCard({
      busy: false,
      values: { ...allOff, notificationsEnabled: true, trayEnabled: true },
      bubbleDurationSec: 15,
      onBubbleDurationChange: () => {},
      onChange: () => {},
    } as never);
    const found = boxes(tree);
    assert.equal(found.length, 5);
    assert.deepEqual(
      found.map((box) => box.props.checked),
      [true, false, false, false, true],
    );
  });

  test('每个开关回传自己的配置字段名', () => {
    const seen: Array<[string, boolean]> = [];
    const tree = GlobalCard({
      busy: false,
      values: allOff,
      bubbleDurationSec: 15,
      onBubbleDurationChange: () => {},
      onChange: (key: string, value: boolean) => seen.push([key, value]),
    } as never);
    for (const box of boxes(tree)) {
      (box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    }
    assert.deepEqual(
      seen.map(([key]) => key),
      ['notificationsEnabled', 'notifyWhenFocused', 'clickSoundEnabled', 'confineToScreen', 'trayEnabled'],
    );
    assert.ok(
      seen.every(([, value]) => value === true),
      '回传的必须是布尔值，不是事件对象',
    );
  });

  test('停留时长是一个数字框：显示当前秒数，带上区间', () => {
    const tree = GlobalCard({
      busy: false,
      values: allOff,
      bubbleDurationSec: 30,
      onBubbleDurationChange: () => {},
      onChange: () => {},
    } as never);
    const box = durationBox(tree);
    assert.ok(box, '卡里必须有且有一个数字框（停留时长）');
    assert.equal(box.props.defaultValue, '30');
    assert.equal(box.props.min, '1');
    assert.equal(box.props.max, '3600');
  });

  test('数字框失焦提交秒数；空串放弃这次编辑（不回传 0）', () => {
    const seen: number[] = [];
    const tree = GlobalCard({
      busy: false,
      values: allOff,
      bubbleDurationSec: 15,
      onBubbleDurationChange: (value: number) => seen.push(value),
      onChange: () => {},
    } as never);
    commitNumber(durationBox(tree), '25');
    assert.deepEqual(seen, [25]);
    // 空串与脏值由 numberInputProps 丢掉：它们都不该变成 0 写进配置（0 = 永不收起）
    commitNumber(durationBox(tree), '');
    commitNumber(durationBox(tree), 'abc');
    commitNumber(durationBox(tree), '15');
    assert.deepEqual(seen, [25], '只有真的变了才回调');
  });

  test('忙时全部控件禁用', () => {
    const tree = GlobalCard({
      busy: true,
      values: allOff,
      bubbleDurationSec: 15,
      onBubbleDurationChange: () => {},
      onChange: () => {},
    } as never);
    for (const input of inputs(tree)) assert.equal(input.props.disabled, true);
  });
});
