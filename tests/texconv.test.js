// LaTeX 数学解析与渲染的回归测试（texconv.js 数学层）
//
// 关注两件事：
//   1. AST 结构正确 —— 用 astToText 的摊平文本做断言，比匹配 XML 更稳
//   2. 输出良构     —— OMML / MathML 必须是配对正确的 XML，否则 Word 判定文档损坏
//
// 运行：node --test tests/texconv.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const texconv = require('../renderer/texconv.js');

const T = (s) => texconv.astToText(s);

/* ---------- 1. 原子 ---------- */

test('原子：变量、数字、运算符', () => {
  assert.strictEqual(T('x'), 'x');
  assert.strictEqual(T('2'), '2');
  assert.strictEqual(T('3.14'), '3.14');
  assert.strictEqual(T('x+y'), 'x+y');
  assert.strictEqual(T('a = b'), 'a=b');
});

test('希腊字母与符号表', () => {
  assert.strictEqual(T('\\alpha'), 'α');
  assert.strictEqual(T('\\Omega'), 'Ω');
  assert.strictEqual(T('\\times'), '×');
  assert.strictEqual(T('\\leq'), '≤');
  assert.strictEqual(T('\\rightarrow'), '→');
  assert.strictEqual(T('\\infty'), '∞');
});

test('正体函数名', () => {
  assert.strictEqual(T('\\sin x'), 'sinx');
  assert.strictEqual(T('\\log_2 n'), 'log_2n');
});

/* ---------- 2. 上下标 ---------- */

test('上下标：单标记与组合', () => {
  assert.strictEqual(T('x^2'), 'x^2');
  assert.strictEqual(T('x_i'), 'x_i');
  assert.strictEqual(T('x_i^2'), 'x_i^2');
  assert.strictEqual(T('x^2_i'), 'x_i^2');
  assert.strictEqual(T('a_{n+1}'), 'a_n+1');
  assert.strictEqual(T('e^{-x^2}'), 'e^-x^2');
});

test('嵌套花括号作用域正确', () => {
  // -x^2 的指数必须是 -x^2，不能被拆成 (-x)^2
  assert.strictEqual(T('e^{-x^2}'), 'e^-x^2');
  // 多层嵌套的上下标
  assert.strictEqual(T('a_{b_{c}}'), 'a_b_c');
});

/* ---------- 3. 分式、根式、二项式 ---------- */

test('分式', () => {
  assert.strictEqual(T('\\frac{a}{b}'), '(a)/(b)');
  assert.strictEqual(T('\\frac{-b}{2a}'), '(-b)/(2a)');
  assert.strictEqual(T('\\frac{\\frac{a}{b}}{c}'), '((a)/(b))/(c)');
});

test('根式：带次数与不带次数', () => {
  assert.strictEqual(T('\\sqrt{x}'), 'sqrt(x)');
  assert.strictEqual(T('\\sqrt[3]{x}'), 'sqrt(x)');
  assert.strictEqual(T('\\sqrt{x^2+y^2}'), 'sqrt(x^2+y^2)');
});

test('二项式系数', () => {
  assert.strictEqual(T('\\binom{n}{k}'), 'C(n,k)');
});

/* ---------- 4. 大运算符 ---------- */

test('求和/求积的上限下限与作用体', () => {
  assert.strictEqual(T('\\sum_{i=1}^{n} a_i'), '∑_i=1^n{a_i}');
  assert.strictEqual(T('\\prod_{k=1}^{n} k'), '∏_k=1^n{k}');
  // 被作用体只吸收紧随的一个单元，其余留在同级 —— 视觉结果一致，
  // 这是刻意的简化（完整作用域分析对 Word 渲染没有额外收益）
  assert.strictEqual(T('\\int_a^b f(x)'), '∫_a^b{f}(x)');
});

test('极限符号取正体文本', () => {
  assert.strictEqual(T('\\lim_{x \\to 0} f'), 'lim_x→0{f}');
});

test('大运算符没有上下限时不吞掉后继内容', () => {
  // 关键回归：\sum 无上下标时不能把后面的项当作 body
  assert.strictEqual(T('\\sum a + b'), '∑a+b');
});

/* ---------- 5. 定界符与矩阵 ---------- */

test('\\left..\\right 自动定界符', () => {
  assert.strictEqual(T('\\left( \\frac{a}{b} \\right)'), '((a)/(b))');
  assert.strictEqual(T('\\left[ x \\right]'), '[x]');
  assert.strictEqual(T('\\left\\{ x \\right\\}'), '{x}');
  // \left. 表示该侧不画定界符
  assert.strictEqual(T('\\left. x \\right|'), 'x|');
});

test('矩阵环境与转置表', () => {
  assert.strictEqual(T('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'), '[a&b];[c&d]');
  assert.strictEqual(T('\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}'), '[1&0];[0&1]');
  assert.strictEqual(T('\\begin{cases} a & x>0 \\\\ b & x<0 \\end{cases}'), '[a&x>0];[b&x<0]');
});

test('矩阵单元格内的上下标不被 \r 误伤', () => {
  assert.strictEqual(T('\\begin{matrix} x^2 & y^2 \\end{matrix}'), '[x^2&y^2]');
});

/* ---------- 6. 重音、文本、字体 ---------- */

test('重音符号', () => {
  assert.strictEqual(T('\\vec{v}'), 'v⃗');
  assert.strictEqual(T('\\bar{x}'), 'x‾');
  assert.strictEqual(T('\\hat{y}'), 'ŷ');
});

test('文本与字体命令', () => {
  assert.strictEqual(T('\\text{中文}'), '中文');
  assert.strictEqual(T('\\mathrm{d}x'), 'dx');
  assert.strictEqual(T('\\mathbb{R}'), 'ℝ');
  assert.strictEqual(T('\\mathbb{Z}^+'), 'ℤ^+');
});

/* ---------- 7. 降级行为 ---------- */

test('未知命令降级为可见原文，不静默丢失', () => {
  assert.strictEqual(T('\\foobar'), '\\foobar');
  assert.strictEqual(T('a \\weirdcmd b'), 'a\\weirdcmdb');
});

test('未闭合的花括号与 \left 不崩溃且不丢内容', () => {
  assert.strictEqual(T('\\frac{a}{'), '(a)/()');
  assert.strictEqual(T('\\left( x'), '(x');
  assert.doesNotThrow(() => T('{{{'));
  assert.doesNotThrow(() => T('}}}'));
});

test('空输入与纯空白', () => {
  assert.strictEqual(T(''), '');
  assert.strictEqual(T('   '), '');
  assert.strictEqual(texconv.mathToOmml(''), '<m:oMath></m:oMath>');
});

/* ---------- 8. 输出良构性 ---------- */

function wellFormed(xml) {
  const re = /<\/?([a-zA-Z][a-zA-Z0-9:]*)(?:\s[^>]*?)?(\/?)>/g;
  const stack = [];
  let m;
  while ((m = re.exec(xml))) {
    const full = m[0];
    const tag = m[1];
    const selfClose = m[2] === '/';
    if (full.charAt(1) === '/') {
      if (stack.pop() !== tag) return { ok: false, at: full, stack: stack.slice() };
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  return { ok: stack.length === 0, stack: stack };
}

const CASES = [
  'x', 'x^2', 'x_i^2', '\\frac{a}{b}', '\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}',
  '\\sum_{i=1}^{n} a_i', '\\int_0^\\infty e^{-x^2}', '\\left( \\frac{a}{b} \\right)',
  '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', '\\vec{v}', '\\text{中文}',
  '\\mathbb{R}^n', '\\lim_{x \\to 0} \\frac{\\sin x}{x}', '\\alpha\\beta\\gamma',
  '\\sqrt[3]{\\frac{x}{y}}', '\\binom{n}{k}', 'x^{a+b}', '\\hat{y} = Wx + b',
  'a_{i,j} = \\sum_{k} u_{ik} v_{kj}'
];

test('OMML 对全部用例良构', () => {
  for (const c of CASES) {
    const o = texconv.mathToOmml(c);
    const w = wellFormed(o);
    assert.ok(w.ok, `OMML 标签不配对：${c}\n  剩余栈=${JSON.stringify(w.stack)}\n  ${o}`);
    assert.match(o, /^<m:oMath>/, `应以 m:oMath 起始：${c}`);
    assert.match(o, /<\/m:oMath>$/, `应以 /m:oMath 结束：${c}`);
  }
});

test('MathML 对全部用例良构', () => {
  for (const c of CASES) {
    for (const disp of [false, true]) {
      const x = texconv.mathToMathML(c, disp);
      const w = wellFormed(x);
      assert.ok(w.ok, `MathML 标签不配对：${c}\n  剩余栈=${JSON.stringify(w.stack)}`);
      assert.match(x, /^<math /);
      assert.match(x, /<\/math>$/);
    }
  }
});

test('OMML 空槽位必须显式给出空 run（否则 Word 判定公式缺损）', () => {
  // \frac{a}{} 的分母是空槽
  const o = texconv.mathToOmml('\\frac{a}{}');
  const den = o.match(/<m:den>([\s\S]*?)<\/m:den>/);
  assert.ok(den, '应有 m:den 槽位');
  assert.match(den[1], /<m:r>/, '空槽也要有 m:r，不能是 <m:den/>');
});

test('槽位内容与预期文本一致（防止结构错位）', () => {
  // 注意：OMML 的槽位（m:e / m:num / m:sub …）按规范允许任意多个子元素，
  // 所以这里断言的是「摊平后的文本」，而不是「顶层元素个数」。
  const o = texconv.mathToOmml('\\frac{a+b}{c} + x^{m+n}');
  const grab = (tag) => {
    const m = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>').exec(o);
    return m ? m[1].replace(/<[^>]+>/g, '') : null;
  };
  assert.strictEqual(grab('m:num'), 'a+b', '分子应是 a+b');
  assert.strictEqual(grab('m:den'), 'c', '分母应是 c');
  assert.strictEqual(grab('m:sup'), 'm+n', '指数应是 m+n');
});

/* ---------- 9. 元素覆盖 ---------- */

test('各类结构都生成了对应的 OMML 元素', () => {
  const map = {
    'x^2': '<m:sSup>',
    'x_1': '<m:sSub>',
    'x_1^2': '<m:sSubSup>',
    '\\frac{a}{b}': '<m:f>',
    '\\sqrt{x}': '<m:rad>',
    '\\sum_{i}^{n}': '<m:nary>',
    '\\left( x \\right)': '<m:d>',
    '\\begin{matrix} a & b \\end{matrix}': '<m:m>',
    '\\vec{v}': '<m:acc>'
  };
  for (const [tex, el] of Object.entries(map)) {
    assert.ok(texconv.mathToOmml(tex).includes(el), `${tex} 应生成 ${el}`);
  }
});

test('块级公式用 m:oMathPara 包裹并居中', () => {
  const p = texconv.mathToOmmlPara('x^2');
  assert.match(p, /^<m:oMathPara>/);
  assert.match(p, /<m:jc m:val="center"\/>/);
  assert.match(p, /<\/m:oMathPara>$/);
  assert.ok(wellFormed(p).ok, '块级公式应良构');
});

/* ---------- v1.3.1：控制字符与 $ 启发式 ---------- */

test('公式文本中的控制字符被剔除，产出仍是良构 XML', () => {
  const o = texconv.mathToOmml('\\text{a\u0007b}');
  assert.ok(!o.includes('\u0007'), '控制字符应被剔除');
  assert.ok(o.includes('ab'), '正文保留');
});

test('isLikelyMath 启发式', () => {
  const M = texconv.isLikelyMath;
  assert.strictEqual(M('x^2'), true);
  assert.strictEqual(M('2+2'), true);
  assert.strictEqual(M('5，那件 '), false, '含全角逗号');
  assert.strictEqual(M('5 and got '), false, '结尾空白');
  assert.strictEqual(M(' x^2'), false, '开头空白');
  assert.strictEqual(M(''), false);
});
