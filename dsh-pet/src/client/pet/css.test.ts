/**
 * 宠物样式注入（src/client/pet/css.ts）的契约测试：滤镜定义 SVG 必须留在文档里供
 * `filter:url(#dsh-pet-alpha-fix)` 解析，但绝不能参与宿主的布局——它一旦撑高文档，
 * DSH 桌面端那条拖拽条就会被顶出视口，主窗口拖不动、双击顶部也不能最大化。
 * 用最小假 DOM，不引 jsdom。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { injectPetCss } from './css.ts';
import { PET_ALPHA_FIX_ENABLED } from '../../shared/constants.ts';

/** 假元素：只实现注入路径真正用到的那几样。 */
interface FakeElement {
  tagName: string;
  /** filter 的 id 由属性直接赋值（`filter.id = …`），不是 setAttribute。 */
  id: string;
  attributes: Record<string, string>;
  children: FakeElement[];
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: FakeElement) => FakeElement;
}

/** 行内样式替身：`setProperty` 是真 DOM 里唯一能写带短横线属性名的方式。 */
function makeStyle(): Record<string, string> {
  const style: Record<string, string> = {};
  Object.defineProperty(style, 'setProperty', {
    value: (name: string, value: string) => {
      style[name] = value;
    },
  });
  return style;
}

/** 造一个假元素。 */
function fakeElement(tagName: string): FakeElement {
  const element: FakeElement = {
    tagName,
    id: '',
    attributes: {},
    children: [],
    dataset: {},
    style: makeStyle(),
    textContent: '',
    setAttribute(name, value) {
      element.attributes[name] = value;
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
  };
  return element;
}

/** 假 document：head/body 各自记子节点，querySelector 只认注入去重用的两个选择器。 */
interface FakeDocument {
  head: FakeElement;
  body: FakeElement;
  createElement: (tag: string) => FakeElement;
  createElementNS: (ns: string, tag: string) => FakeElement;
  querySelector: (selector: string) => FakeElement | null;
}

/** 装一套假 DOM，跑完还原。 */
function withFakeDom(run: (dom: FakeDocument) => void): void {
  const head = fakeElement('head');
  const body = fakeElement('body');
  const dom: FakeDocument = {
    head,
    body,
    createElement: (tag) => fakeElement(tag),
    createElementNS: (_ns, tag) => fakeElement(tag),
    querySelector: (selector) => {
      if (selector.startsWith('style[')) {
        return head.children.find((child) => child.tagName === 'style') ?? null;
      }
      if (selector.startsWith('svg[')) return findByTag(body, 'svg');
      return null;
    },
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = dom;
  try {
    run(dom);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

/** 在树里按标签名找第一个节点。 */
function findByTag(root: FakeElement, tagName: string): FakeElement | null {
  for (const child of root.children) {
    if (child.tagName === tagName) return child;
    const found = findByTag(child, tagName);
    if (found !== null) return found;
  }
  return null;
}

/** body 下那个滤镜定义节点；没有就断言失败。 */
function alphaFilterSvg(dom: FakeDocument): FakeElement {
  const svg = findByTag(dom.body, 'svg');
  assert.ok(svg !== null, 'body 下应当有滤镜定义 SVG');
  return svg;
}

/** 取本次注入的样式表文本；没有就断言失败。 */
function injectedCss(dom: FakeDocument): string {
  const style = dom.head.children.find((child) => child.tagName === 'style');
  assert.ok(style !== undefined, 'head 下应当有注入的样式表');
  return style.textContent;
}

describe('injectPetCss', () => {
  test('滤镜 SVG 固定定位到原点且零尺寸，不参与宿主布局', () => {
    if (!PET_ALPHA_FIX_ENABLED) return; // 共享开关默认关闭：滤镜不注入，本条只在开启时有效
    withFakeDom((dom) => {
      injectPetCss();

      const svg = alphaFilterSvg(dom);
      assert.equal(svg.style.position, 'fixed');
      assert.equal(svg.style.top, '0');
      assert.equal(svg.style.left, '0');
      assert.equal(svg.style.width, '0');
      assert.equal(svg.style.height, '0');
      assert.equal(svg.style.overflow, 'hidden');
      assert.equal(svg.style.pointerEvents, 'none');
      // 行内流才是撑高文档的根源：静止/绝对定位都会在 #root 之后留下位置。
      assert.notEqual(svg.style.position, 'absolute');
    });
  });

  test('滤镜定义仍在文档里，id 与视频的 filter 引用一致', () => {
    if (!PET_ALPHA_FIX_ENABLED) return; // 同上
    withFakeDom((dom) => {
      injectPetCss();

      const filter = findByTag(alphaFilterSvg(dom), 'filter');
      assert.ok(filter !== null, 'SVG 里应当有 <filter>');
      assert.equal(filter.id, 'dsh-pet-alpha-fix');
      assert.ok(injectedCss(dom).includes('filter:url(#dsh-pet-alpha-fix)'));
    });
  });

  test('样式表带 !important 兜底，压住刷新前旧 bundle 留下的同款节点', () => {
    withFakeDom((dom) => {
      injectPetCss();

      const css = injectedCss(dom);
      assert.ok(css.includes('svg[data-dsh-pet-alpha-fix]{'));
      for (const declaration of [
        'position:fixed!important',
        'width:0!important',
        'height:0!important',
        'overflow:hidden!important',
        'pointer-events:none!important',
      ]) {
        assert.ok(css.includes(declaration), `兜底规则缺少 ${declaration}`);
      }
    });
  });

  test('重复注入只留一份样式表与一个滤镜节点', () => {
    if (!PET_ALPHA_FIX_ENABLED) return; // 同上
    withFakeDom((dom) => {
      injectPetCss();
      injectPetCss();

      assert.equal(dom.head.children.filter((child) => child.tagName === 'style').length, 1);
      assert.equal(dom.body.children.filter((child) => child.tagName === 'svg').length, 1);
    });
  });
});
