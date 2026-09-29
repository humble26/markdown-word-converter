// docxread.js 的回归测试：.docx 反向解析、类型识别与互补推荐
//
// 关注点：
//   1. 往返：docxgen 产出的 .docx 能被 docxread 读回同义 Markdown
//   2. 结构：标题 / 强调 / 列表 / 表格 / 公式 的 OOXML → Markdown 映射
//   3. 识别：扩展名 + 内容嗅探判定类型，并给出互补的导出格式
//   4. 兜底：旧版二进制 .doc 明确报错；HTML 形态 .doc 正常解析
//
// 运行：node --test tests/docxread.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const docxgen = require('../renderer/docxgen.js');
const texconv = require('../renderer/texconv.js');
const docxread = require('../renderer/docxread.js');

const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf-8'));

/* 用应用自身的导出链路造一个真实 .docx，再读回来 —— 端到端往返 */
function buildDocx(html) {
  return docxgen.build(html, {
    mathToOmml: (tex, block) => (block ? texconv.mathToOmmlPara(tex) : texconv.mathToOmml(tex))
  });
}
async function roundTrip(html) {
  const r = await docxread.readDocx(buildDocx(html));
  return r.text;
}

/* ==================================================================
   一、OOXML → Markdown 结构映射
   ================================================================== */

test('标题：Heading1..3 还原为 #/##/###', async () => {
  const md = await roundTrip('<h1>一级</h1><h2>二级</h2><h3>三级</h3>');
  assert.match(md, /^# 一级$/m);
  assert.match(md, /^## 二级$/m);
  assert.match(md, /^### 三级$/m);
});

test('强调：粗体 / 斜体 / 删除线', async () => {
  const md = await roundTrip('<p>这是<strong>粗</strong>与<em>斜</em>还有<del>删</del></p>');
  assert.match(md, /\*\*粗\*\*/);
  assert.match(md, /\*斜\*/);
  assert.match(md, /~~删~~/);
});

test('无序列表还原为 - 项', async () => {
  const md = await roundTrip('<ul><li>甲</li><li>乙</li></ul>');
  assert.match(md, /^- 甲$/m);
  assert.match(md, /^- 乙$/m);
});

test('有序列表还原为 1. 2. 递增序号', async () => {
  const md = await roundTrip('<ol><li>第一</li><li>第二</li></ol>');
  assert.match(md, /^1\. 第一$/m);
  assert.match(md, /^2\. 第二$/m);
});

test('嵌套列表按两空格缩进', async () => {
  const md = await roundTrip('<ul><li>父<ul><li>子</li></ul></li></ul>');
  assert.match(md, /^- 父$/m);
  assert.match(md, /^ {2}- 子$/m);
});

test('表格还原为 Markdown 表格，首行作表头', async () => {
  const md = await roundTrip(
    '<table><thead><tr><th>姓名</th><th>分数</th></tr></thead>'
    + '<tbody><tr><td>张三</td><td>90</td></tr></tbody></table>');
  assert.match(md, /\| 姓名 \| 分数 \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| 张三 \| 90 \|/);
});

test('超链接保留为 Markdown 链接', async () => {
  const md = await roundTrip('<p>见 <a href="https://example.com/a">文档</a></p>');
  assert.match(md, /\[文档\]\(https:\/\/example\.com\/a\)/);
});

test('行内公式：OMML 还原为 $...$', async () => {
  const md = await roundTrip('<p>结果是 <span class="math-inline" data-tex="x^2">x²</span></p>');
  assert.match(md, /\$x\^\{2\}\$/);
});

test('块级公式：oMathPara 还原为 $$ 围栏', async () => {
  const md = await roundTrip('<div class="math-block" data-tex="\\frac{a}{b}">ab</div>');
  assert.match(md, /\$\$\n\\frac\{a\}\{b\}\n\$\$/);
});

test('公式端到端往返：根式次数、大运算符上下限、重音不丢', async () => {
  // 这三个是 v1.4.1 修掉的结构 bug：m:deg 位置、m:nary 槽位、bar 重音字符
  const cases = [
    ['\\sqrt[3]{x}', /\$\\sqrt\[3\]\{x\}\$/],
    ['\\sum_{i=1}^{n} i', /\$\\sum_\{i=1\}\^\{n\} i\$/],
    ['\\int_0^1 f(x)dx', /\$\\int_\{0\}\^\{1\} f\(x\)dx\$/],
    ['\\bar{y}', /\$\\bar\{y\}\$/]
  ];
  for (const [tex, re] of cases) {
    const md = await roundTrip('<p><span class="math-inline" data-tex="' + tex + '">x</span></p>');
    assert.match(md, re, `${tex} 往返结果不符：${md}`);
  }
});

test('XML 非法控制字符被剔除后仍可读回', async () => {
  // 垂直制表符属于 XML 1.0 非法字符，docxgen 会剔除；这里确认不会破坏解析
  const md = await roundTrip('<p>前\u000b后</p>');
  assert.match(md, /前后/);
});

test('空文档不崩溃，给出告警', async () => {
  const r = await docxread.readDocx(buildDocx(''));
  assert.strictEqual(typeof r.text, 'string');
  assert.ok(r.warnings.some((w) => w.includes('没有可提取的文本')));
});

/* ==================================================================
   二、类型识别与互补推荐
   ================================================================== */

test('扩展名优先判定类型', () => {
  assert.strictEqual(docxread.sniffKind('a.tex', ''), 'latex');
  assert.strictEqual(docxread.sniffKind('a.latex', ''), 'latex');
  assert.strictEqual(docxread.sniffKind('a.md', ''), 'markdown');
  assert.strictEqual(docxread.sniffKind('a.markdown', ''), 'markdown');
  assert.strictEqual(docxread.sniffKind('a.docx', ''), 'docx');
  assert.strictEqual(docxread.sniffKind('a.doc', ''), 'doc');
});

test('无扩展名 / .txt 靠内容嗅探', () => {
  assert.strictEqual(docxread.sniffKind('a.txt', '\\documentclass{article}\n\\begin{document}'), 'latex');
  assert.strictEqual(docxread.sniffKind('a.txt', '\\begin{itemize}\n\\item x'), 'latex');
  assert.strictEqual(docxread.sniffKind('a.txt', '# 标题\n\n正文'), 'markdown');
  assert.strictEqual(docxread.sniffKind('notes', '普通文本'), 'markdown');
});

test('互补推荐：Markdown/Word → tex，LaTeX → docx', () => {
  assert.strictEqual(docxread.recommendFormat('markdown'), 'tex');
  assert.strictEqual(docxread.recommendFormat('docx'), 'tex');
  assert.strictEqual(docxread.recommendFormat('doc'), 'tex');
  assert.strictEqual(docxread.recommendFormat('latex'), 'docx');
});

/* ==================================================================
   三、readDropped：拖入入口
   ================================================================== */

test('拖入 .md：按 Markdown 直接采用', async () => {
  const r = await docxread.readDropped('说明.md', utf8('# 标题\n\n正文'));
  assert.strictEqual(r.kind, 'markdown');
  assert.strictEqual(r.source, 'markdown');
  assert.strictEqual(r.text, '# 标题\n\n正文');
});

test('拖入 .tex：识别为 LaTeX 并保留原文', async () => {
  const r = await docxread.readDropped('doc.tex', utf8('\\section{引言}\n正文'));
  assert.strictEqual(r.kind, 'latex');
  assert.strictEqual(r.source, 'latex');
  assert.match(r.text, /\\section\{引言\}/);
});

test('拖入 .txt 且内容是 LaTeX：嗅探为 latex', async () => {
  const r = await docxread.readDropped('code.txt', utf8('\\documentclass{article}\n\\begin{document}x\\end{document}'));
  assert.strictEqual(r.kind, 'latex');
});

test('拖入 .docx：反向解析为 Markdown', async () => {
  const r = await docxread.readDropped('报告.docx', buildDocx('<h1>周报</h1><p>进展顺利</p>'));
  assert.strictEqual(r.kind, 'markdown');
  assert.strictEqual(r.source, 'docx');
  assert.match(r.text, /# 周报/);
  assert.match(r.text, /进展顺利/);
});

test('拖入 HTML 形态的 .doc：解析出 Markdown', async () => {
  const html = '<html><body><h1>标题</h1><p>正文</p><ul><li>甲</li><li>乙</li></ul></body></html>';
  const r = await docxread.readDropped('旧文档.doc', utf8(html));
  assert.strictEqual(r.source, 'doc');
  assert.match(r.text, /# 标题/);
  assert.match(r.text, /- 甲/);
});

test('拖入旧版二进制 .doc（OLE）：明确报错并给出指引', async () => {
  const ole = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]);
  await assert.rejects(
    () => docxread.readDropped('旧.doc', ole),
    /OLE|另存为/);
});

test('拖入空文件：报错而非静默', async () => {
  await assert.rejects(() => docxread.readDropped('空.md', new Uint8Array(0)), /空/);
});

/* ==================================================================
   四、底层能力（单独可测）
   ================================================================== */

test('isZip / isOle 魔数判定', () => {
  assert.strictEqual(docxread.isZip(buildDocx('<p>x</p>')), true);
  assert.strictEqual(docxread.isZip(utf8('plain')), false);
  assert.strictEqual(docxread.isOle(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0])), true);
  assert.strictEqual(docxread.isOle(utf8('plain')), false);
});

test('decodeText：UTF-8 与 GBK 兜底', () => {
  assert.strictEqual(docxread.decodeText(utf8('中文测试')), '中文测试');
  // 「中文测试」的 GBK 字节：不是合法 UTF-8，应自动退回 GBK 解码
  const gbk = new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4]);
  assert.strictEqual(docxread.decodeText(gbk), '中文测试');
});

test('unzip：能读出 docxgen 产出的 document.xml', () => {
  const files = docxread.unzip(buildDocx('<p>hello</p>'));
  assert.ok(files['word/document.xml'], '应含 word/document.xml');
  assert.ok(files['[Content_Types].xml'], '应含 [Content_Types].xml');
});

test('htmlToMarkdown：嵌套列表与表格', () => {
  const nested = docxread.htmlToMarkdown('<ul><li>父<ul><li>子</li></ul></li></ul>').text;
  assert.match(nested, /- 父/);
  assert.match(nested, /^ {2}- 子/m);

  const tbl = docxread.htmlToMarkdown(
    '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>').text;
  assert.match(tbl, /\| a \| b \|/);
  assert.match(tbl, /\| 1 \| 2 \|/);
});

test('往返稳定：Markdown 语义经 docx 一圈后保留', async () => {
  const html = '<h1>标题</h1><p>这是<strong>重点</strong>。</p>'
    + '<ul><li>一</li><li>二</li></ul>'
    + '<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>';
  const md = await roundTrip(html);
  assert.match(md, /^# 标题$/m);
  assert.match(md, /\*\*重点\*\*/);
  assert.match(md, /^- 一$/m);
  assert.match(md, /\| k \| v \|/);
  assert.match(md, /\| a \| 1 \|/);
});