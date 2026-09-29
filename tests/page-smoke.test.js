// 页面级冒烟测试：在最小 DOM 桩里真实执行 index.html / web 单文件版的内联脚本
//
// 单元测试覆盖了解析逻辑，这里补上「接线」这一层：
//   - 脚本能否无异常加载、docxgen/texconv/docxread 是否都挂到 window
//   - 拖入不同文件后，输入框内容与导出格式下拉框是否按互补规则自动切换
//
// 运行：node --test tests/page-smoke.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGES = {
  '桌面版 index.html': path.join(__dirname, '..', 'renderer', 'index.html'),
  '网页单文件版': path.join(__dirname, '..', 'web', 'markdown-word-converter.html'),
};

function makeEl() {
  return {
    value: '', innerHTML: '', textContent: '', className: '', scrollTop: 0,
    style: {}, attrs: {}, files: null, type: '', accept: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener() {}, appendChild() {}, removeChild() {}, click() {},
    querySelector() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; } }
  };
}

function loadPage(file) {
  const dir = path.dirname(file);
  const html = fs.readFileSync(file, 'utf-8');
  // 外链 <script src> 也要真正读进来（桌面版把 docxgen/texconv/docxread 放在独立文件里）
  const blocks = [];
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\ssrc\s*=\s*"([^"]+)"/.exec(m[1] || '');
    if (src) blocks.push(fs.readFileSync(path.join(dir, src[1]), 'utf-8'));
    else if (m[2].trim()) blocks.push(m[2]);
  }

  const els = {};
  const document = {
    getElementById: (id) => els[id] || (els[id] = makeEl()),
    createElement: () => makeEl(),
    addEventListener() {},
    body: makeEl(),
    execCommand() { return true; },
    querySelector() { return null; }
  };

  const sandbox = {
    document, console, setTimeout, clearTimeout,
    navigator: {}, URL, Blob, atob, btoa,
    TextDecoder, TextEncoder,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    isFinite, parseInt, parseFloat
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const code of blocks) vm.runInContext(code, ctx, { filename: file });
  return { ctx, els };
}

/* 在页面上下文里跑一遍真实流程，返回可断言的结果 */
async function runFlow(ctx) {
  const script = `(async () => {
    const results = {};

    results.modules = {
      docxgen: typeof docxgen,
      texconv: typeof texconv,
      docxread: typeof docxread
    };

    const html = '<h1>标题</h1><p>正文<strong>粗</strong></p>'
      + '<ul><li>甲</li><li>乙</li></ul>'
      + '<p>公式 <span class="math-inline" data-tex="x^2">x2</span></p>';
    const bytes = docxgen.build(html, {
      mathToOmml: (t, b) => b ? texconv.mathToOmmlPara(t) : texconv.mathToOmml(t)
    });

    // 1) 拖入 .docx → 反向解析为 Markdown，导出格式自动切到 .tex
    await applyFile('报告.docx', bytes);
    results.docx = {
      input: document.getElementById('input').value,
      format: document.getElementById('exportFormat').value,
      toast: document.getElementById('toast').textContent
    };

    // 2) 拖入 .tex → 转成 Markdown，导出格式自动切到 .docx
    await applyFile('文档.tex', new TextEncoder().encode('\\\\section{引言}\\n正文'));
    results.tex = {
      input: document.getElementById('input').value,
      format: document.getElementById('exportFormat').value
    };

    // 3) 拖入 .md → 直接采用，导出格式自动切到 .tex
    await applyFile('说明.md', new TextEncoder().encode('# 标题\\n\\n正文'));
    results.md = {
      input: document.getElementById('input').value,
      format: document.getElementById('exportFormat').value
    };

    // 4) 拖入旧版二进制 .doc → 报错提示而非崩溃
    await applyFile('旧.doc', new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]));
    results.ole = { toast: document.getElementById('toast').textContent };

    return results;
  })()`;
  return vm.runInContext(script, ctx, { filename: 'flow.js' });
}

for (const [label, file] of Object.entries(PAGES)) {
  test(label + '：脚本可加载且三个模块都挂上 window', () => {
    const { ctx } = loadPage(file);
    assert.strictEqual(typeof ctx.docxgen, 'object');
    assert.strictEqual(typeof ctx.texconv, 'object');
    assert.strictEqual(typeof ctx.docxread, 'object');
    assert.strictEqual(typeof ctx.docxread.readDropped, 'function');
    assert.strictEqual(typeof ctx.applyFile, 'function');
  });

  test(label + '：拖入 → 识别 → 互补推荐导出格式', async () => {
    const { ctx } = loadPage(file);
    const r = await runFlow(ctx);

    assert.strictEqual(r.modules.docxgen, 'object');
    assert.strictEqual(r.modules.docxread, 'object');

    // .docx → Markdown
    assert.match(r.docx.input, /# 标题/);
    assert.match(r.docx.input, /\*\*粗\*\*/);
    assert.match(r.docx.input, /- 甲/);
    assert.match(r.docx.input, /\$x\^\{2\}\$/);
    assert.strictEqual(r.docx.format, 'tex', 'Word 输入应推荐导出 .tex');
    assert.match(r.docx.toast, /反向转换为 Markdown/);

    // .tex → Markdown
    assert.match(r.tex.input, /# 引言/);
    assert.strictEqual(r.tex.format, 'docx', 'LaTeX 输入应推荐导出 .docx');

    // .md → Markdown
    assert.match(r.md.input, /# 标题/);
    assert.strictEqual(r.md.format, 'tex', 'Markdown 输入应推荐导出 .tex');

    // 旧版二进制 .doc 明确报错
    assert.match(r.ole.toast, /OLE|另存为/);
  });
}