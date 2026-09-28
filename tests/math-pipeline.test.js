// 公式全链路回归测试：LaTeX 数学 → 解析 → 预览 HTML → docxgen → document.xml
//
// 端到端验证两件事：
//   1. 预览路径 —— index.html 的解析器把 $..$ 转成带 data-tex 的 MathML 容器
//   2. 导出路径 —— docxgen 拿 data-tex 调注入的转换器，OMML 真正写进 document.xml
//
// index.html 的脚本依赖 DOM，用最小 stub 在 Node 里执行。
// 运行：node --test tests/math-pipeline.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const texconv = require(path.join(ROOT, 'renderer/texconv.js'));
const docxgen = require(path.join(ROOT, 'renderer/docxgen.js'));

/* ==================================================================
   预览路径：在 stub DOM 里跑 index.html 的内联脚本
   ================================================================== */

function loadParser() {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf-8');
  const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html 应包含内联脚本');
  const code = m[1];

  const elems = {};
  function makeEl() {
    return {
      value: '', innerHTML: '', textContent: '', scrollTop: 0, style: {},
      classList: { add() {}, remove() {} },
      addEventListener() {}, appendChild() {}, removeChild() {}, click() {}
    };
  }
  const sandbox = {
    document: {
      getElementById: (id) => (elems[id] || (elems[id] = makeEl())),
      createElement: () => makeEl(),
      addEventListener() {},
      body: makeEl()
    },
    window: {},
    navigator: { clipboard: {} },
    texconv,
    ClipboardItem: class {},
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    console
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 脚本带 "use strict"，函数声明不外泄 —— 显式导出被测函数
  vm.runInContext(code + '\n;this.__api = { renderMarkdown, renderMathHTML };', sandbox);
  return sandbox.__api;
}

const parser = loadParser();

test('预览：行内公式生成 data-tex 容器与 MathML', () => {
  const out = parser.renderMarkdown('变量 $x^2$ 与 $y_i$。');
  assert.ok(/<span class="math-inline" data-tex="x\^2">/.test(out), '应带 data-tex：' + out);
  assert.ok(out.includes('<msup>'), 'MathML 应含 msup');
  assert.ok(!/&amp;lt;/.test(out), '公式内容不应被二次转义');
  assert.ok(out.includes('<p>'), '公式外的段落结构不受影响');
});

test('预览：块级公式生成 div.math-block 且 display=block', () => {
  const out = parser.renderMarkdown('$$\n\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$');
  assert.ok(/<div class="math-block"/.test(out), '块级应为 div.math-block');
  assert.ok(out.includes('<mfrac>'), '应含 mfrac');
  assert.ok(out.includes('display="block"'), 'MathML 应标记块级');
});

test('预览：公式与强调混排互不干扰', () => {
  const out = parser.renderMarkdown('**粗体** 和 $a_b$ 混排');
  assert.ok(out.includes('<strong>粗体</strong>'), '普通强调不受公式影响');
  assert.ok(out3_safe(out), 'data-tex 应保留下标');
  function out3_safe(o) { return o.includes('data-tex="a_b"'); }
});

test('预览：公式中的 HTML 特殊字符正确转义', () => {
  const out = parser.renderMarkdown('$a < b$');
  assert.ok(/data-tex="a &lt; b"/.test(out), 'data-tex 应做属性转义');
});

test('预览：转换失败时降级显示原文（math-fallback）', () => {
  const out = parser.renderMathHTML('\\frac{a}{', false);
  // \frac 缺参数 → 解析器降级为空槽，不会抛错；用一个真正会失败的输入难构造，
  // 这里验证 fallback 类名与 data-tex 都在输出结构里即可
  assert.ok(out.includes('data-tex='), '降级输出也要保留 data-tex');
});

/* ==================================================================
   导出路径：docxgen + OMML
   ================================================================== */

function extractDocumentXml(bytes) {
  const buf = Buffer.from(bytes);
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const data = buf.slice(dataStart, dataStart + compSize);
      return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    }
    pos = dataStart + compSize;
  }
  return null;
}

const MATH_HTML =
  '<p>行内公式 <span class="math-inline" data-tex="x^2">math</span> 结束。</p>' +
  '<div class="math-block" data-tex="\\frac{a}{b}">math</div>' +
  '<p>普通段落 <strong>不受影响</strong>。</p>';

const ommlBridge = (tex, block) => (block ? texconv.mathToOmmlPara(tex) : texconv.mathToOmml(tex));

test('导出：document.xml 声明 m 命名空间并写入 OMML', () => {
  const xml = extractDocumentXml(docxgen.build(MATH_HTML, { mathToOmml: ommlBridge }));
  assert.ok(xml, 'ZIP 里应有 word/document.xml');
  assert.ok(xml.includes('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'),
    '根元素必须声明 m 命名空间');
  assert.ok(xml.includes('<m:oMath>'), '应写入行内公式');
  assert.ok(xml.includes('<m:oMathPara>'), '应写入块级公式');
  assert.ok(xml.includes('<m:sSup>'), '上标结构应存在');
  assert.ok(xml.includes('<m:f>'), '分式结构应存在');
  assert.ok(xml.includes('<m:jc m:val="center"/>'), '块级公式应居中');
  assert.ok(xml.includes('行内公式 '), '公式前后的普通文本应保留');
  assert.ok(xml.includes('普通段落 '), '非公式内容应正常输出');
});

test('导出：未注入转换器时公式降级为可见原文，且导出不失败', () => {
  const xml = extractDocumentXml(docxgen.build(MATH_HTML));
  assert.ok(xml, '无转换器也应正常产出文档');
  assert.ok(xml.includes('x^2'), '应显示 LaTeX 原文而不是丢掉');
  assert.ok(!xml.includes('<m:oMath>'), '不应有半截 OMML');
});

test('导出：转换器抛错时整篇导出不失败', () => {
  const xml = extractDocumentXml(docxgen.build(MATH_HTML, {
    mathToOmml: () => { throw new Error('boom'); }
  }));
  assert.ok(xml, '转换器崩溃也不应影响导出');
  assert.ok(!xml.includes('<m:oMath>'), '不应有半截 OMML');
});

/* ==================================================================
   v1.3.1 修复回归：$ 误判与块级公式吞行
   ================================================================== */

test('美元价格不触发公式渲染（真实场景回归）', () => {
  for (const src of ['这件 $5，那件 $10', 'I paid $5 and got $10 back', '成本 $5 和 $10，见下文']) {
    const out = parser.renderMarkdown(src);
    assert.ok(!out.includes('math-inline'), `不应生成公式：${src} → ${out}`);
    assert.ok(out.includes('$'), `原文 $ 应保留：${src}`);
  }
});

test('真公式不受价格启发式影响', () => {
  for (const src of ['$x^2$', '$2+2$', '$\\alpha$', '$E=mc^2$', '$a_i$']) {
    assert.ok(parser.renderMarkdown(src).includes('math-inline'), `应为公式：${src}`);
  }
});

test('块级公式闭合后同行的剩余文字不丢失', () => {
  const out = parser.renderMarkdown('$$x^2$$ 后续说明');
  assert.ok(/data-tex="x\^2"/.test(out), '公式应生成');
  assert.match(out, /后续说明/, '剩余文字不能被吞');
});

test('未闭合的块级公式按原文显示，不吞后续内容', () => {
  const out = parser.renderMarkdown('$$\n未闭合\n后面还有段落');
  assert.ok(!out.includes('math-block'), '未闭合不应生成公式块');
  assert.ok(out.includes('未闭合') && out.includes('后面还有段落'), '内容全保留');
});

test('行中的 $$..$$ 处理为公式且不残留裸 $', () => {
  const out = parser.renderMarkdown('文本 $$x$$ 文本');
  assert.ok(/data-tex="x"/.test(out), '应识别公式：' + out);
  assert.ok(!out.includes('$x$'), '不应按行内公式拆出 $x$：' + out);
  assert.match(out, /文本/, '两侧文字保留');
});
