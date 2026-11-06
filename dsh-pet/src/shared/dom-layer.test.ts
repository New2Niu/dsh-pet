/**
 * 浮层挂载入口（src/shared/dom-layer.ts）的契约测试。
 *
 * 钉住两件事：
 *   ① 行内必须写 `-webkit-app-region: initial`——宿主的
 *      `html[data-platform=darwin] body>:not(#root){-webkit-app-region:no-drag}` 把 body 子节点算成
 *      no-drag 矩形，铺满视口的浮层会把整窗拖拽区减没（主窗口拖不动、双击顶部不最大化）；
 *   ② 源码里不许再出现裸的 `document.body.appendChild(`——绕过这里就等于绕过上面那条修正。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { appendPetLayer } from './dom-layer.ts';

/** 假元素：只实现挂载路径用到的三样。 */
interface FakeElement {
  tagName: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  styleWrites: string[];
  setAttribute: (name: string, value: string) => void;
  style_: { setProperty: (name: string, value: string) => void };
}

/** 造一个假元素。 */
function fakeElement(tagName: string): FakeElement {
  const element: FakeElement = {
    tagName,
    attributes: {},
    style: {},
    styleWrites: [],
    setAttribute(name, value) {
      element.attributes[name] = value;
    },
    style_: {
      setProperty(name, value) {
        element.style[name] = value;
        element.styleWrites.push(name);
      },
    },
  };
  return element;
}

/** 把假元素的 `style_` 暴露成 `style`（函数签名要求的是真 CSSStyleDeclaration）。 */
function asLayerable(element: FakeElement): HTMLElement {
  Object.defineProperty(element, 'style', { value: element.style_, enumerable: true });
  return element as unknown as HTMLElement;
}

/** 装一套假 document，跑完还原。 */
function withFakeBody(run: (body: { children: FakeElement[] }) => void): void {
  const body = { children: [] as FakeElement[] } as {
    children: FakeElement[];
    appendChild?: (child: FakeElement) => FakeElement;
  };
  body.appendChild = (child) => {
    body.children.push(child);
    return child;
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { body };
  try {
    run(body);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

describe('appendPetLayer', () => {
  test('挂到 body，并用行内 initial 抵消宿主的 no-drag', () => {
    withFakeBody((body) => {
      const el = fakeElement('div');

      const returned = appendPetLayer(asLayerable(el));

      assert.equal(returned, el as unknown as HTMLElement);
      assert.deepEqual(body.children, [el]);
      assert.equal(el.style['-webkit-app-region'], 'initial');
      // `none` 不在该属性的关键字表里，写进去会被丢掉——这条断言防的是"改回 none"。
      assert.notEqual(el.style['-webkit-app-region'], 'none');
    });
  });

  test('打上 data-dsh-pet-layer 标记，便于宿主侧与调试时辨认', () => {
    withFakeBody(() => {
      const el = fakeElement('div');

      appendPetLayer(asLayerable(el));

      assert.equal(el.attributes['data-dsh-pet-layer'], '');
    });
  });

  test('SVG（滤镜定义节点）同样接得住', () => {
    withFakeBody((body) => {
      const svg = fakeElement('svg');

      appendPetLayer(asLayerable(svg) as unknown as SVGElement);

      assert.deepEqual(body.children, [svg]);
      assert.equal(svg.style['-webkit-app-region'], 'initial');
    });
  });
});

describe('源码守卫', () => {
  test('src 下不再有裸的 document.body.appendChild(', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (file.endsWith('.test.ts')) continue;
      // 唯一允许直接 append 的地方就是入口自己。
      if (file.endsWith('shared/dom-layer.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('document.body.appendChild(')) offenders.push(file.slice(root.length));
    }
    assert.deepEqual(offenders, [], '这些文件绕过了 appendPetLayer：' + offenders.join(', '));
  });
});

/** 递归收集目录下的 .ts 文件。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = dir + entry.name;
    if (entry.isDirectory()) out.push(...walk(full + '/'));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
