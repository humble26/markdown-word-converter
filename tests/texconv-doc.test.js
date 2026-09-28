// 文档层双向转换的回归测试（texconv.js 的 mdToLatex / latexToMd）
//
// 三个关注点：
//   1. 正向：Markdown 各类结构映射到正确的 LaTeX 命令
//   2. 反向：LaTeX 常见命令与环境还原成 Markdown
//   3. 不丢内容：认不出的命令必须原样保留并进告警清单，不能静默消失
//
// 运行：node --test tests/texconv-doc.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { mdToLatex, latexToMd } = require('../renderer/texconv.js');

/* 只要正文片段，不要导言区 */
const MD = (s) => mdToLatex(s, { standalone: true }).text;
const LATEX = (s) => latexToMd(s).text;

/* ==================================================================
   Markdown → LaTeX
   ================================================================== */

test('标题：六级映射到章节命令', () => {
  assert.strictEqual(MD('# 一级'), '\\section{一级}');
  assert.strictEqual(MD('## 二级'), '\\subsection{二级}');
  assert.strictEqual(MD('### 三级'), '\\subsubsection{三级}');
  assert.strictEqual(MD('#### 四级'), '\\paragraph{四级}');
  assert.strictEqual(MD('##### 五级'), '\\subparagraph{五级}');
  assert.strictEqual(MD('###### 六级'), '\\subparagraph{六级}');
});

test('强调与行内代码', () => {
  assert.strictEqual(MD('这是 **粗体**'), '这是 \\textbf{粗体}');
  assert.strictEqual(MD('这是 *斜体*'), '这是 \\emph{斜体}');
  assert.strictEqual(MD('这是 `code`'), '这是 \\texttt{code}');
  assert.strictEqual(MD('~~删除~~'), '\\sout{删除}');
});

test('LaTeX 特殊字符必须转义', () => {
  assert.strictEqual(MD('a_b'), 'a\\_b');
  assert.strictEqual(MD('100%'), '100\\%');
  assert.strictEqual(MD('A & B'), 'A \\& B');
  assert.strictEqual(MD('#tag'), '\\#tag');
  assert.strictEqual(MD('a~b'), 'a\\textasciitilde{}b');
  assert.strictEqual(MD('x^2'), 'x\\textasciicircum{}2');
});

test('公式内的特殊字符不被转义（关键回归）', () => {
  // 公式里的 _ ^ & 是 LaTeX 数学语法本身，转义就废了
  assert.strictEqual(MD('$a_b$'), '$a_b$');
  assert.strictEqual(MD('设 $x_i^2$ 为'), '设 $x_i^2$ 为');
  assert.strictEqual(MD('$$\\frac{a}{b}$$'), '\\[\n\\frac{a}{b}\n\\]');
});

test('行内代码内的特殊字符做转义', () => {
  // 与公式相反：代码是普通文本，_ 需要转义
  assert.strictEqual(MD('`a_b`'), '\\texttt{a\\_b}');
});

test('块级公式：单行与多行', () => {
  assert.strictEqual(MD('$$x^2$$'), '\\[\nx^2\n\\]');
  assert.strictEqual(MD('$$\na + b\n$$'), '\\[\na + b\n\\]');
});

test('无序与有序列表', () => {
  assert.strictEqual(MD('- a\n- b'), '\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}');
  assert.strictEqual(MD('1. a\n2. b'), '\\begin{enumerate}\n\\item a\n\\item b\n\\end{enumerate}');
});

test('嵌套列表生成嵌套环境', () => {
  const out = MD('- a\n  - b\n- c');
  assert.match(out, /\\begin\{itemize\}/);
  assert.strictEqual((out.match(/\\begin\{itemize\}/g) || []).length, 2, '应有两层 itemize');
  assert.strictEqual((out.match(/\\item/g) || []).length, 3);
});

test('列表序号类型中途切换会重开环境', () => {
  const out = MD('- a\n1. b');
  assert.match(out, /\\end\{itemize\}/);
  assert.match(out, /\\begin\{enumerate\}/);
});

test('表格 → tabular，列对齐跟随分隔行', () => {
  const out = MD('| a | b |\n| --- | ---: |\n| 1 | 2 |');
  assert.match(out, /\\begin\{tabular\}\{\|l\|r\|\}/, '对齐应是 l 与 r');
  assert.match(out, /\\textbf\{a\} & \\textbf\{b\} \\\\/);
  assert.match(out, /1 & 2 \\\\/);
  assert.match(out, /\\end\{tabular\}/);
});

test('代码块 → verbatim，内容不做任何转义', () => {
  const out = MD('```\nif a_b & c:\n```');
  assert.strictEqual(out, '\\begin{verbatim}\nif a_b & c:\n\\end{verbatim}');
});

test('引用块嵌套转换', () => {
  const out = MD('> **注意**\n> 第二行');
  assert.match(out, /\\begin\{quote\}/);
  assert.match(out, /\\textbf\{注意\}/);
  assert.match(out, /\\end\{quote\}/);
});

test('链接与图片', () => {
  assert.strictEqual(MD('[文字](https://a.b)'), '\\href{https://a.b}{文字}');
  assert.strictEqual(MD('![图](img/a.png)'), '\\includegraphics[width=0.9\\linewidth]{img/a.png}');
});

test('完整文档包装含必要宏包与 ctex 文档类', () => {
  const r = mdToLatex('# 标题\n\n正文');
  assert.match(r.text, /\\documentclass\[11pt\]\{ctexart\}/, '中文需要 ctex 文档类');
  assert.match(r.text, /\\usepackage\[normalem\]\{ulem\}/, '\\sout 需要 ulem');
  assert.match(r.text, /amsmath/);
  assert.match(r.text, /hyperref/);
  assert.match(r.text, /\\begin\{document\}/);
  assert.match(r.text, /\\end\{document\}/);
});

/* ==================================================================
   LaTeX → Markdown
   ================================================================== */

test('章节命令还原为标题（层级与正向映射对称）', () => {
  assert.strictEqual(LATEX('\\section{标题}'), '# 标题\n');
  assert.strictEqual(LATEX('\\subsection{子节}'), '## 子节\n');
  assert.strictEqual(LATEX('\\subsubsection{孙节}'), '### 孙节\n');
  assert.strictEqual(LATEX('\\chapter{章}'), '# 章\n');
});

test('强调命令还原', () => {
  assert.strictEqual(LATEX('\\textbf{粗}'), '**粗**\n');
  assert.strictEqual(LATEX('\\emph{斜}'), '*斜*\n');
  assert.strictEqual(LATEX('\\texttt{码}'), '`码`\n');
  assert.strictEqual(LATEX('\\textit{斜}'), '*斜*\n');
});

test('列表环境还原为 Markdown 列表', () => {
  assert.strictEqual(LATEX('\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}'), '- a\n- b\n');
  assert.strictEqual(LATEX('\\begin{enumerate}\n\\item a\n\\item b\n\\end{enumerate}'), '1. a\n2. b\n');
});

test('嵌套列表按深度缩进', () => {
  const src = '\\begin{itemize}\n\\item a\n\\begin{enumerate}\n\\item b\n\\end{enumerate}\n\\end{itemize}';
  const out = LATEX(src);
  assert.match(out, /^- a/m);
  assert.match(out, /^ {2}1\. b/m, '子项应缩进两格');
});

test('tabular 还原为 Markdown 表格', () => {
  const src = '\\begin{tabular}{|l|c|}\n\\hline\n姓名 & 分数 \\\\\n\\hline\n张三 & 90 \\\\\n\\hline\n\\end{tabular}';
  const out = LATEX(src);
  assert.match(out, /\| 姓名 \| 分数 \|/);
  assert.match(out, /\| --- \| --- \|/);
  assert.match(out, /\| 张三 \| 90 \|/);
});

test('数学环境还原为 $$ 围栏', () => {
  assert.match(LATEX('\\begin{equation}\nx = 1\n\\end{equation}'), /\$\$\n[\s\S]*x = 1[\s\S]*\n\$\$/);
  assert.match(LATEX('\\[a+b\\]'), /\$\$\n[\s\S]*a\+b[\s\S]*\n\$\$/);
  assert.strictEqual(LATEX('\\(a+b\\)'), '$a+b$\n');
});

test('align 环境包成 aligned 以便 Markdown 渲染器识别', () => {
  const out = LATEX('\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}');
  assert.match(out, /\\begin\{aligned\}/);
  assert.match(out, /\\end\{aligned\}/);
});

test('去掉注释，但保留转义的字面百分号', () => {
  assert.strictEqual(LATEX('a % 这是注释\nb'), 'a\nb\n');
  assert.strictEqual(LATEX('50\\% off'), '50% off\n');
});

test('verbatim 原样转成围栏代码块，内部不被改写', () => {
  const src = '\\begin{verbatim}\na_b & c \\\\ d\n\\end{verbatim}';
  assert.strictEqual(LATEX(src), '```\na_b & c \\\\ d\n```\n');
});

test('只取 document 环境内的正文', () => {
  const src = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n正文\n\\end{document}';
  assert.strictEqual(LATEX(src), '正文\n');
});

test('删除 \\label，保留 \\ref 与 \\cite 的可见痕迹', () => {
  assert.strictEqual(LATEX('\\label{sec:1}正文'), '正文\n');
  assert.match(LATEX('见 \\ref{fig:1}'), /\[ref: fig:1\]/);
  assert.match(LATEX('如前所述\\cite{knuth}'), /\[cite: knuth\]/);
});

test('链接与图片还原', () => {
  assert.strictEqual(LATEX('\\href{https://a.b}{文字}'), '[文字](https://a.b)\n');
  assert.match(LATEX('\\includegraphics[width=2cm]{img/a.png}'), /!\[a\.png\]\(img\/a\.png\)/);
});

test('转义字符还原为普通字符', () => {
  assert.strictEqual(LATEX('a\\_b \\& c\\% d\\# e\\{f\\}'), 'a_b & c% d# e{f}\n');
  assert.strictEqual(LATEX('\\textbackslash{}cmd'), '\\cmd\n');
});

/* ==================================================================
   不丢内容 / 告警
   ================================================================== */

test('未识别的命令原样保留并进入告警清单', () => {
  const r = latexToMd('调用 \\foobar{参数} 结束');
  assert.match(r.text, /\\foobar\{参数\}/, '未识别命令必须保留，不能删掉');
  assert.ok(r.warnings.includes('foobar'), '应告警 foobar，实际：' + JSON.stringify(r.warnings));
});

test('同一命令只告警一次', () => {
  const r = latexToMd('\\weird{a} 和 \\weird{b} 还有 \\weird{c}');
  assert.strictEqual(r.warnings.filter((w) => w === 'weird').length, 1);
});

test('已知命令不产生误报告警', () => {
  const r = latexToMd('\\section{标题}\n\n\\textbf{粗}\n\n\\begin{itemize}\n\\item x\n\\end{itemize}\n\n\\label{a}');
  assert.deepStrictEqual(r.warnings, [], '常规文档不应有告警，实际：' + JSON.stringify(r.warnings));
});

test('空输入与纯空白不崩溃', () => {
  assert.strictEqual(LATEX(''), '\n');
  assert.strictEqual(MD(''), '');
  assert.doesNotThrow(() => latexToMd('\\begin{itemize}'));
  assert.doesNotThrow(() => latexToMd('}}}[[['));
});

/* ==================================================================
   往返稳定性
   ================================================================== */

test('往返：Markdown → LaTeX → Markdown 语义不变', () => {
  const src = [
    '# 标题',
    '',
    '这是 **粗体** 和 *斜体*。',
    '',
    '- 项目一',
    '- 项目二',
    '',
    '公式 $E = mc^2$ 保持原样。'
  ].join('\n');

  const tex = mdToLatex(src).text;
  const back = latexToMd(tex).text;

  assert.match(back, /^# 标题/m, '标题应还原为一级');
  assert.match(back, /\*\*粗体\*\*/);
  assert.match(back, /\*斜体\*/);
  assert.match(back, /- 项目一/);
  assert.match(back, /\$E = mc\^2\$/, '行内公式应保持');
});

test('往返：LaTeX → Markdown → LaTeX 保留关键结构', () => {
  const src = [
    '\\section{引言}',
    '',
    '本文讨论 \\textbf{重点} 内容。',
    '',
    '\\begin{itemize}',
    '\\item 第一点',
    '\\item 第二点',
    '\\end{itemize}',
    '',
    '\\begin{equation}',
    'a^2 + b^2 = c^2',
    '\\end{equation}'
  ].join('\n');

  const md = latexToMd(src).text;
  const back = mdToLatex(md, { standalone: true }).text;

  assert.match(back, /\\section\{引言\}/);
  assert.match(back, /\\textbf\{重点\}/);
  assert.match(back, /\\begin\{itemize\}/);
  assert.match(back, /\\item 第一点/);
  assert.match(back, /a\^2 \+ b\^2 = c\^2/, '公式内容应完整保留');
});
