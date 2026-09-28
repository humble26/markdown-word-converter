/* texconv.js — Markdown ↔ LaTeX 双向转换（零第三方依赖、离线可用）
   浏览器与 Node 均可运行，风格与 docxgen.js 保持一致。

   两个层次：
   ┌ 数学层：LaTeX 数学串 → Math AST ─┬→ MathML （预览：浏览器原生渲染）
   │                                  └→ OMML   （导出：Word 可编辑公式）
   └ 文档层：Markdown ↔ LaTeX (.tex)

   设计取舍：解析器只吃 LaTeX 数学的**实用子集** —— 上下标、分式、根式、
   大运算符、定界符、矩阵、重音、正体文本与完整符号表。遇到不认识的命令
   不抛错，降级为可见的原文（\foo），保证「转不了」永远好过「转出错」。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.texconv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==================================================================
     一、符号表
     ================================================================== */

  /* 直接映射为单个 Unicode 字符的命令 */
  var SYMBOLS = {
    /* 希腊字母（小写） */
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
    varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    /* 希腊字母（大写） */
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    /* 二元运算符 */
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '⋅', ast: '∗', star: '⋆',
    circ: '∘', bullet: '∙', oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘',
    odot: '⊙', cap: '∩', cup: '∪', wedge: '∧', vee: '∨', setminus: '∖',
    sqcap: '⊓', sqcup: '⊔', amalg: '⨿', wr: '≀', dagger: '†', ddagger: '‡',
    /* 关系符 */
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡',
    approx: '≈', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
    subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', nsubseteq: '⊈',
    in: '∈', notin: '∉', ni: '∋', perp: '⊥', parallel: '∥', asymp: '≍',
    doteq: '≐', models: '⊨', vdash: '⊢', smile: '⌣', frown: '⌢',
    /* 箭头 */
    to: '→', gets: '←', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹',
    iff: '⟺', uparrow: '↑', downarrow: '↓', updownarrow: '↕',
    mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵', longmapsto: '⟼',
    hookrightarrow: '↪', hookleftarrow: '↩', nearrow: '↗', searrow: '↘',
    /* 其他常用符号 */
    infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄',
    emptyset: '∅', varnothing: '∅', angle: '∠', triangle: '△', square: '□',
    cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
    Re: 'ℜ', Im: 'ℑ', wp: '℘', ell: 'ℓ', hbar: 'ℏ', imath: 'ı', jmath: 'ȷ',
    prime: '′', degree: '°', checkmark: '✓', clubsuit: '♣', diamondsuit: '♢',
    heartsuit: '♡', spadesuit: '♠', aleph: 'ℵ', beth: 'ℶ', top: '⊤', bot: '⊥',
    vert: '|', lVert: '‖', rVert: '‖', langle: '⟨', rangle: '⟩',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    /* 逻辑/集合专用（保持间距语义） */
    land: '∧', lor: '∨', lnot: '¬', neg: '¬', therefore: '∴', because: '∵'
  };

  /* 需要上下限的大运算符 */
  var BIG_OPS = {
    sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂',
    bigoplus: '⨁', bigotimes: '⨂', bigodot: '⨀', bigvee: '⋁', bigwedge: '⋀',
    bigsqcup: '⨆', biguplus: '⨄', int: '∫', iint: '∬', iiint: '∭',
    oint: '∮', oiint: '∯'
  };

  /* \lim 这类「大运算符形态但内容是文字」的命令 */
  var LIM_OPS = {
    lim: 'lim', limsup: 'lim sup', liminf: 'lim inf',
    max: 'max', min: 'min', sup: 'sup', inf: 'inf',
    det: 'det', gcd: 'gcd', Pr: 'Pr', lcm: 'lcm'
  };

  /* 正体函数名 */
  var FUNCS = {
    sin: 1, cos: 1, tan: 1, cot: 1, sec: 1, csc: 1,
    arcsin: 1, arccos: 1, arctan: 1, arccot: 1,
    sinh: 1, cosh: 1, tanh: 1, coth: 1,
    log: 1, ln: 1, lg: 1, exp: 1, ker: 1, dim: 1, hom: 1, arg: 1, deg: 1
  };

  /* 重音：LaTeX 命令 → [OMML 重音字符, MathML 重音符号] */
  var ACCENTS = {
    vec: ['⃗', '→'], hat: ['̂', '^'], widehat: ['̂', '^'],
    bar: ['‾', '‾'], overline: ['‾', '‾'],
    tilde: ['̃', '~'], widetilde: ['̃', '~'],
    dot: ['̇', '˙'], ddot: ['̈', '¨'],
    check: ['̌', 'ˇ'], breve: ['̆', '˘'], acute: ['́', '´'], grave: ['̀', '`']
  };

  /* 下方标注 */
  var UNDER_ACCENTS = {
    underline: ['_', '_'], underbrace: ['⏟', '⏟']
  };

  /* 间距命令 → OMML 的 m:argSz / 直接用空格字符更稳妥 */
  var SPACES = {
    ',' : ' ', ':' : ' ', ';' : ' ', '!' : '', quad: '  ', qquad: '    '
  };

  /* 数学字母表：只覆盖有 Unicode 对应且常用的部分，其余回退普通字母 */
  var BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ', E: '𝔼', F: '𝔽' };
  var CAL = { L: 'ℒ', M: 'ℳ', B: 'ℬ', E: 'ℰ', F: 'ℱ', G: '𝒢', H: 'ℋ', I: 'ℐ', R: 'ℛ' };

  /* 定界符：\left \right 与 \big 系列后面允许出现的符号 */
  var DELIMS = {
    '(': '(', ')': ')', '[': '[', ']': ']', '{': '{', '}': '}',
    '|': '|', '/': '/', '.': '', '\\': '', 'langle': '⟨', 'rangle': '⟩',
    'vert': '|', 'Vert': '‖', 'lVert': '‖', 'rVert': '‖', '|': '|',
    'lceil': '⌈', 'rceil': '⌉', 'lfloor': '⌊', 'rfloor': '⌋',
    'uparrow': '↑', 'downarrow': '↓', 'updownarrow': '↕'
  };

  /* 矩阵类环境 */
  var MATRIX_ENVS = {
    matrix: { open: '', close: '' },
    pmatrix: { open: '(', close: ')' },
    bmatrix: { open: '[', close: ']' },
    Bmatrix: { open: '{', close: '}' },
    vmatrix: { open: '|', close: '|' },
    Vmatrix: { open: '‖', close: '‖' },
    cases: { open: '{', close: '' },
    array: { open: '', close: '' },
    aligned: { open: '', close: '' },
    align: { open: '', close: '' },
    gathered: { open: '', close: '' }
  };

  /* ==================================================================
     二、词法分析
     ================================================================== */

  function tokenize(src) {
    var toks = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src.charAt(i);

      if (c === '\\') {
        var m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
        if (!m) { i++; continue; }
        var name = m[1];
        i += m[0].length;
        /* \\ 是换行，不是命令 */
        if (name === '\\') toks.push({ t: 'row' });
        else toks.push({ t: 'cmd', name: name });
        continue;
      }

      if (c === '{') { toks.push({ t: 'open' }); i++; continue; }
      if (c === '}') { toks.push({ t: 'close' }); i++; continue; }
      if (c === '^') { toks.push({ t: 'sup' }); i++; continue; }
      if (c === '_') { toks.push({ t: 'sub' }); i++; continue; }
      if (c === '&') { toks.push({ t: 'amp' }); i++; continue; }
      if (c === '[') { toks.push({ t: 'lbr' }); i++; continue; }
      if (c === ']') { toks.push({ t: 'rbr' }); i++; continue; }
      if (/\s/.test(c)) { i++; continue; }

      if (/[0-9]/.test(c)) {
        var m2 = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i));
        toks.push({ t: 'num', v: m2[0] });
        i += m2[0].length;
        continue;
      }

      toks.push({ t: 'char', v: c });
      i++;
    }
    return toks;
  }

  /* ==================================================================
     三、语法分析 → Math AST
     ================================================================== */

  function parse(src) {
    var toks = tokenize(String(src == null ? '' : src));
    var pos = 0;

    function peek(k) { return toks[pos + (k || 0)]; }
    function atEnd() { return pos >= toks.length; }

    /* 组的边界：close / 上下标 / 大运算符的 body 分界 */
    function isStop(t, endType) {
      if (!t) return true;
      if (endType && t.t === endType) return true;
      if (t.t === 'close') return true;
      if (t.t === 'sup' || t.t === 'sub') return true;
      if (t.t === 'amp' || t.t === 'row') return true;
      return false;
    }

    /* 解析一个「单元」：{...} 整体 或 单个原子 */
    function parseUnit() {
      var t = peek();
      if (!t) return { type: 'empty' };
      if (t.t === 'open') {
        pos++;
        var items = parseItems('close');
        if (peek() && peek().t === 'close') pos++;
        return { type: 'group', items: items };
      }
      return parseAtom();
    }

    /* 连续解析若干原子，直到遇到 endType 或停止符 */
    function parseItems(endType) {
      var items = [];
      while (!atEnd() && !isStop(peek(), endType)) {
        items.push(parseScripted());
      }
      return items;
    }

    /* 原子 + 可选上下标 */
    function parseScripted() {
      var base = parseAtom();
      var sup = null, sub = null;
      while (!atEnd() && (peek().t === 'sup' || peek().t === 'sub')) {
        var kind = peek().t;
        pos++;
        var g = parseUnit();
        if (kind === 'sup') { if (sup === null) sup = g; else base = { type: 'sup', base: base, sup: g }; }
        else { if (sub === null) sub = g; else base = { type: 'sub', base: base, sub: g }; }
      }

      /* 大运算符吸收紧随其后的一个单元作为被作用体 */
      if (base.type === 'op' && (sup || sub)) {
        var body = null;
        if (!atEnd() && !isStop(peek(), null) && peek().t !== 'cmdStop') {
          body = parseScripted();
        }
        return { type: 'nary', name: base.name, chr: base.chr, text: base.text, sup: sup, sub: sub, body: body };
      }

      if (sup && sub) return { type: 'subsup', base: base, sup: sup, sub: sub };
      if (sup) return { type: 'sup', base: base, sup: sup };
      if (sub) return { type: 'sub', base: base, sub: sub };
      return base;
    }

    /* 读取紧随 \left / \right 之后的定界符字符 */
    function readDelim() {
      var t = peek();
      if (!t) return '';
      if (t.t === 'char') { pos++; return DELIMS[t.v] != null ? DELIMS[t.v] : t.v; }
      if (t.t === 'open') { pos++; return '{'; }
      if (t.t === 'close') { pos++; return '}'; }
      if (t.t === 'cmd') {
        pos++;
        /* \{ \} \| 这类转义定界符 */
        if (t.name === '{') return '{';
        if (t.name === '}') return '}';
        if (t.name === '|') return '‖';
        if (DELIMS[t.name] != null) return DELIMS[t.name];
        return '';
      }
      if (t.t === 'lbr') { pos++; return '['; }
      if (t.t === 'rbr') { pos++; return ']'; }
      return '';
    }

    /* \begin{env} ... \end{env} —— 按 & 分列、\\ 分行 */
    function parseEnv() {
      /* 环境名 */
      var env = '';
      var t = peek();
      if (t && t.t === 'open') {
        pos++;
        var buf = '';
        while (!atEnd() && peek().t !== 'close') {
          var x = peek(); pos++;
          if (x.t === 'char') buf += x.v;
          else if (x.t === 'cmd') buf += '\\' + x.name;
        }
        if (peek() && peek().t === 'close') pos++;
        env = buf;
      }

      var rows = [[]];
      var cell = null;
      while (!atEnd()) {
        var tk = peek();
        if (tk.t === 'cmd' && tk.name === 'end') {
          pos++;
          /* 吃掉 {env} */
          if (peek() && peek().t === 'open') {
            pos++;
            while (!atEnd() && peek().t !== 'close') pos++;
            if (peek() && peek().t === 'close') pos++;
          }
          break;
        }
        if (tk.t === 'amp') { pos++; rows[rows.length - 1].push(cell || { type: 'empty' }); cell = null; continue; }
        if (tk.t === 'row') { pos++; rows[rows.length - 1].push(cell || { type: 'empty' }); rows.push([]); cell = null; continue; }
        if (tk.t === 'sup' || tk.t === 'sub') {
          /* \begin{array} 里可能紧跟 {c} 列格式说明，已在上面吞掉；这里作为异常兜底 */
          pos++; continue;
        }
        if (tk.t === 'open') {
          /* array 的 {ccc} 列声明：出现在第一行第一列之前，直接跳过 */
          var save = pos;
          pos++;
          var inner = '';
          var depth = 1, ok = true;
          while (!atEnd() && depth > 0) {
            var y = peek();
            if (y.t === 'open') depth++;
            else if (y.t === 'close') { depth--; if (depth === 0) { pos++; break; } }
            else if (y.t === 'char') inner += y.v;
            pos++;
          }
          if (rows.length === 1 && rows[0].length === 0 && !cell && /^[lcr|@\s{}pmb]+$/.test(inner)) continue;
          pos = save;
        }
        var unit = parseScripted();
        if (cell && cell.type === 'group') cell.items.push(unit);
        else if (cell) cell = { type: 'group', items: [cell, unit] };
        else cell = unit;
      }
      rows[rows.length - 1].push(cell || { type: 'empty' });
      /* 去掉末尾因换行产生的空行 */
      if (rows.length > 1) {
        var last = rows[rows.length - 1];
        if (last.length === 1 && last[0].type === 'empty') rows.pop();
      }
      return { type: 'matrix', env: env, rows: rows };
    }

    /* 读取 {...} 的原始文本（用于 \text / \begin 的参数） */
    function readRawText() {
      var t = peek();
      if (!t) return '';
      if (t.t !== 'open') {
        var one = parseUnit();
        return collectRaw(one);
      }
      pos++;
      var buf = '';
      var depth = 1;
      while (!atEnd() && depth > 0) {
        var x = peek(); pos++;
        if (x.t === 'open') { depth++; buf += '{'; continue; }
        if (x.t === 'close') { depth--; if (depth === 0) break; buf += '}'; continue; }
        if (x.t === 'cmd') { buf += '\\' + x.name; continue; }
        if (x.t === 'char') { buf += x.v; continue; }
        if (x.t === 'num') { buf += x.v; continue; }
        if (x.t === 'sup') { buf += '^'; continue; }
        if (x.t === 'sub') { buf += '_'; continue; }
      }
      return buf;
    }

    function collectRaw(node) {
      if (!node) return '';
      if (node.type === 'sym' || node.type === 'ident' || node.type === 'num') return String(node.v);
      if (node.type === 'func') return node.v;
      if (node.type === 'group') return node.items.map(collectRaw).join('');
      if (node.type === 'raw') return node.v;
      return '';
    }

    function parseAtom() {
      var t = peek();
      if (!t) return { type: 'empty' };

      if (t.t === 'num') { pos++; return { type: 'num', v: t.v }; }

      if (t.t === 'char') {
        pos++;
        var ch = t.v;
        /* 单字符就是变量；运算符单独成 <mo> */
        if ('+-=<>*/()[]|,;:!?'.indexOf(ch) >= 0) return { type: 'sym', v: ch };
        if (ch === "'") return { type: 'sym', v: '′' };
        if (ch === '-') return { type: 'sym', v: '−' };
        return { type: 'ident', v: ch };
      }

      if (t.t === 'open') return parseUnit(); /* { 开头的裸组 */

      if (t.t === 'cmd') {
        var name = t.name;
        pos++;

        /* --- 分式 --- */
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
          return { type: 'frac', num: parseUnit(), den: parseUnit() };
        }
        /* --- 二项式系数 --- */
        if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
          return { type: 'binom', num: parseUnit(), den: parseUnit() };
        }
        /* --- 根式 --- */
        if (name === 'sqrt') {
          var deg = null;
          if (peek() && peek().t === 'lbr') {
            pos++;
            deg = { type: 'group', items: parseItems('rbr') };
            if (peek() && peek().t === 'rbr') pos++;
          }
          return { type: 'sqrt', deg: deg, body: parseUnit() };
        }
        /* --- 大运算符 --- */
        if (BIG_OPS[name]) return { type: 'op', name: name, chr: BIG_OPS[name] };
        if (LIM_OPS[name]) return { type: 'op', name: name, chr: LIM_OPS[name], text: true };
        if (name === 'operatorname') {
          var on = readRawText();
          return { type: 'op', name: on, chr: on, text: true };
        }
        /* --- 定界符 --- */
        if (name === 'left') {
          var open = readDelim();
          var items = [];
          while (!atEnd()) {
            var q = peek();
            if (q.t === 'cmd' && q.name === 'right') { pos++; break; }
            items.push(parseScripted());
          }
          var close = readDelim();
          return { type: 'delim', open: open, close: close, items: items };
        }
        if (name === 'right') { /* 落单的 \right，忽略 */ return { type: 'empty' }; }
        if (name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg'
          || name === 'bigl' || name === 'Bigl' || name === 'biggl' || name === 'Biggl'
          || name === 'bigr' || name === 'Bigr' || name === 'biggr' || name === 'Biggr'
          || name === 'bigm' || name === 'Bigm') {
          var d = readDelim();
          return { type: 'sym', v: d || '' };
        }
        /* --- 环境 --- */
        if (name === 'begin') return parseEnv();
        if (name === 'end') {
          if (peek() && peek().t === 'open') { pos++; while (!atEnd() && peek().t !== 'close') pos++; if (peek()) pos++; }
          return { type: 'empty' };
        }
        /* --- 重音 --- */
        if (ACCENTS[name]) return { type: 'accent', chr: ACCENTS[name][0], mathml: ACCENTS[name][1], body: parseUnit() };
        if (UNDER_ACCENTS[name]) return { type: 'under', chr: UNDER_ACCENTS[name][0], body: parseUnit() };
        if (name === 'overbrace') return { type: 'over', chr: '⏞', body: parseUnit() };
        if (name === 'underbrace') return { type: 'under', chr: '⏟', body: parseUnit() };
        /* --- 文本与字体 --- */
        if (name === 'text' || name === 'textrm' || name === 'mbox' || name === 'hbox') {
          return { type: 'text', v: readRawText(), style: 'p' };
        }
        if (name === 'mathrm' || name === 'operatorname') return { type: 'text', v: readRawText(), style: 'p' };
        if (name === 'mathbf' || name === 'boldsymbol' || name === 'bm') return { type: 'text', v: readRawText(), style: 'b' };
        if (name === 'mathit') return { type: 'text', v: readRawText(), style: 'i' };
        if (name === 'mathbb') return { type: 'bb', v: readRawText() };
        if (name === 'mathcal' || name === 'mathscr') return { type: 'cal', v: readRawText() };
        if (name === 'mathsf') return { type: 'text', v: readRawText(), style: 'p' };
        if (name === 'mathtt') return { type: 'text', v: readRawText(), style: 'p' };
        /* --- 间距 --- */
        if (SPACES[name] != null) return { type: 'space', v: SPACES[name] };
        /* --- 函数名 --- */
        if (FUNCS[name]) return { type: 'func', v: name };
        /* --- 普通符号 --- */
        if (SYMBOLS[name] != null) return { type: 'sym', v: SYMBOLS[name], cmd: name };
        /* --- 未识别：原样保留，保证可见而非静默丢失 --- */
        return { type: 'raw', v: '\\' + name };
      }

      /* 兜底：任何未预期的 token 都前进一格，避免死循环 */
      pos++;
      return { type: 'empty' };
    }

    var items = parseItems(null);
    return { type: 'root', items: items };
  }

  /* ==================================================================
     四、AST → MathML（供浏览器原生渲染预览）
     ================================================================== */

  function escXml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mathmlOf(nodes) {
    return nodes.map(function (n) { return mlNode(n); }).join('');
  }

  function mlNode(n) {
    if (!n) return '';
    switch (n.type) {
      case 'empty': return '';
      case 'num': return '<mn>' + escXml(n.v) + '</mn>';
      case 'ident': return '<mi>' + escXml(n.v) + '</mi>';
      case 'sym': return '<mo>' + escXml(n.v) + '</mo>';
      /* 无上下标的大运算符（\sum、\lim …）：按普通符号输出。
         漏掉这个分支会让 ∑ 在整条链路上凭空消失。 */
      case 'op': return '<mo>' + escXml(n.chr) + '</mo>';
      case 'func': return '<mi mathvariant="normal">' + escXml(n.v) + '</mi>';
      case 'raw': return '<mtext>' + escXml(n.v) + '</mtext>';
      case 'text': return '<mtext>' + escXml(n.v) + '</mtext>';
      case 'space': return '<mspace width="0.3em"/>';
      case 'group': return '<mrow>' + mathmlOf(n.items) + '</mrow>';
      case 'sup': return '<msup>' + mlWrap(n.base) + mlWrap(n.sup) + '</msup>';
      case 'sub': return '<msub>' + mlWrap(n.base) + mlWrap(n.sub) + '</msub>';
      case 'subsup': return '<msubsup>' + mlWrap(n.base) + mlWrap(n.sub) + mlWrap(n.sup) + '</msubsup>';
      case 'frac': return '<mfrac>' + mlWrap(n.num) + mlWrap(n.den) + '</mfrac>';
      case 'binom':
        return '<mfenced open="(" close=")"><mfrac linethickness="0">'
          + mlWrap(n.num) + mlWrap(n.den) + '</mfrac></mfenced>';
      case 'sqrt':
        return n.deg
          ? '<mroot>' + mlWrap(n.body) + mlWrap(n.deg) + '</mroot>'
          : '<msqrt>' + mlWrap(n.body) + '</msqrt>';
      case 'nary': {
        var op = '<mo>' + escXml(n.chr) + '</mo>';
        var und = n.sub ? mlWrap(n.sub) : '<mrow/>';
        var ovr = n.sup ? mlWrap(n.sup) : null;
        var core = ovr ? '<munderover>' + op + und + ovr + '</munderover>'
                       : '<munder>' + op + und + '</munder>';
        return '<mrow>' + core + (n.body ? mlWrap(n.body) : '') + '</mrow>';
      }
      case 'delim':
        return '<mfenced open="' + escXml(n.open) + '" close="' + escXml(n.close) + '">'
          + mathmlOf(n.items) + '</mfenced>';
      case 'matrix': {
        var rows = n.rows.map(function (r) {
          return '<mtr>' + r.map(function (c) { return '<mtd>' + mlWrap(c) + '</mtd>'; }).join('') + '</mtr>';
        }).join('');
        var tbl = '<mtable>' + rows + '</mtable>';
        var env = MATRIX_ENVS[n.env];
        if (env && (env.open || env.close)) {
          return '<mfenced open="' + escXml(env.open) + '" close="' + escXml(env.close) + '">' + tbl + '</mfenced>';
        }
        return tbl;
      }
      case 'accent': return '<mover>' + mlWrap(n.body) + '<mo>' + escXml(n.mathml || n.chr) + '</mo></mover>';
      case 'under': return '<munder>' + mlWrap(n.body) + '<mo>' + escXml(n.chr) + '</mo></munder>';
      case 'over': return '<mover>' + mlWrap(n.body) + '<mo>' + escXml(n.chr) + '</mo></mover>';
      case 'bb': {
        var s = '';
        for (var i = 0; i < n.v.length; i++) {
          s += '<mi>' + escXml(BLACKBOARD[n.v.charAt(i)] || n.v.charAt(i)) + '</mi>';
        }
        return '<mrow>' + s + '</mrow>';
      }
      case 'cal': {
        var s2 = '';
        for (var j = 0; j < n.v.length; j++) {
          s2 += '<mi>' + escXml(CAL[n.v.charAt(j)] || n.v.charAt(j)) + '</mi>';
        }
        return '<mrow>' + s2 + '</mrow>';
      }
      case 'root': return mathmlOf(n.items);
      default: return '';
    }
  }

  /* 需要保证是单个元素的场合（msup/mfrac 的槽位） */
  function mlWrap(n) {
    if (!n) return '<mrow/>';
    if (n.type === 'group') return '<mrow>' + mathmlOf(n.items) + '</mrow>';
    var s = mlNode(n);
    return s || '<mrow/>';
  }

  function mathToMathML(tex, display) {
    var ast = parse(tex);
    var inner = mathmlOf(ast.items);
    return '<math xmlns="http://www.w3.org/1998/Math/MathML"'
      + (display ? ' display="block"' : '')
      + '>' + (inner || '<mrow/>') + '</math>';
  }

  /* ==================================================================
     五、AST → OMML（供 .docx 导出为 Word 原生可编辑公式）
     ================================================================== */

  var MATH_FONT = '<w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/>';

  function ommlRun(text, style) {
    if (text === '') return '';
    var mpr = style && style !== 'i' ? '<m:rPr><m:sty m:val="' + style + '"/></m:rPr>' : '';
    return '<m:r>' + mpr + '<w:rPr>' + MATH_FONT + '</w:rPr>'
      + '<m:t xml:space="preserve">' + escXml(text) + '</m:t></m:r>';
  }

  function ommlOf(nodes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var piece = ommlNode(nodes[i]);
      if (!piece) continue;
      /* 相邻的纯文本 run 合并，减少 Word 里的 run 数量 */
      var prev = out[out.length - 1];
      if (piece.runs && prev && prev.runs) {
        prev.runs = prev.runs.concat(piece.runs);
        prev.xml = prev.runs.map(function (r) { return ommlRun(r.t, r.s); }).join('');
      } else {
        out.push(piece);
      }
    }
    return out.map(function (p) { return p.xml; }).join('');
  }

  /* 统一包装：文本类节点产出 runs 以便合并，其余直接给 xml */
  function wrap(xml, runs) { return { xml: xml, runs: runs || null }; }

  function ommlNode(n) {
    if (!n) return null;
    switch (n.type) {
      case 'empty': return null;
      case 'num': return wrap(ommlRun(n.v, 'p'), [{ t: n.v, s: 'p' }]);
      case 'ident': return wrap(ommlRun(n.v, 'i'), [{ t: n.v, s: 'i' }]);
      case 'sym': return wrap(ommlRun(n.v, 'p'), [{ t: n.v, s: 'p' }]);
      /* 同上：无上下标的大运算符必须仍然输出字符本身 */
      case 'op': return wrap(ommlRun(n.chr, 'p'), [{ t: n.chr, s: 'p' }]);
      case 'func': return wrap(ommlRun(n.v, 'p'), [{ t: n.v, s: 'p' }]);
      case 'raw': return wrap(ommlRun(n.v, 'p'), [{ t: n.v, s: 'p' }]);
      case 'text': return wrap(ommlRun(n.v, n.style || 'p'), [{ t: n.v, s: n.style || 'p' }]);
      case 'space': return wrap(ommlRun(' ', 'p'));
      case 'group': return wrap(ommlOf(n.items));
      case 'sup': return wrap('<m:sSup><m:e>' + ommlSlot(n.base) + '</m:e><m:sup>' + ommlSlot(n.sup) + '</m:sup></m:sSup>');
      case 'sub': return wrap('<m:sSub><m:e>' + ommlSlot(n.base) + '</m:e><m:sub>' + ommlSlot(n.sub) + '</m:sub></m:sSub>');
      case 'subsup': return wrap('<m:sSubSup><m:e>' + ommlSlot(n.base) + '</m:e><m:sub>' + ommlSlot(n.sub)
        + '</m:sub><m:sup>' + ommlSlot(n.sup) + '</m:sup></m:sSubSup>');
      case 'frac': return wrap('<m:f><m:fPr><m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:fPr>'
        + '<m:num>' + ommlSlot(n.num) + '</m:num><m:den>' + ommlSlot(n.den) + '</m:den></m:f>');
      case 'binom': return wrap('<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/>'
        + '<m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:dPr><m:e>'
        + '<m:f><m:fPr><m:type m:val="noBar"/><m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:fPr>'
        + '<m:num>' + ommlSlot(n.num) + '</m:num><m:den>' + ommlSlot(n.den) + '</m:den></m:f>'
        + '</m:e></m:d>');
      case 'sqrt': {
        var degXml = n.deg
          ? '<m:deg>' + ommlSlot(n.deg) + '</m:deg>'
          : '<m:degHide m:val="1"/><m:deg/>';
        return wrap('<m:rad><m:radPr>' + degXml + '<m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:radPr>'
          + '<m:e>' + ommlSlot(n.body) + '</m:e></m:rad>');
      }
      case 'nary': {
        var isText = !!n.text;
        var pr = '<m:naryPr><m:chr m:val="' + escXml(n.chr) + '"/>'
          + '<m:limLoc m:val="' + (isText ? 'undOvr' : 'subSup') + '"/>';
        if (isText) pr += '<m:subHide m:val="0"/><m:supHide m:val="0"/>';
        pr += '<m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:naryPr>';
        var subX = n.sub && n.sub.type !== 'empty' ? ommlSlot(n.sub) : (isText ? '<m:sub><m:r><w:rPr>' + MATH_FONT + '</w:rPr><m:t/></m:r></m:sub>' : '<m:sub/>');
        var supX = n.sup && n.sup.type !== 'empty' ? ommlSlot(n.sup) : (isText ? '<m:sup><m:r><w:rPr>' + MATH_FONT + '</w:rPr><m:t/></m:r></m:sup>' : '<m:sup/>');
        return wrap('<m:nary>' + pr + subX + supX + '<m:e>' + ommlSlot(n.body) + '</m:e></m:nary>');
      }
      case 'delim':
        return wrap('<m:d><m:dPr>'
          + (n.open ? '<m:begChr m:val="' + escXml(n.open) + '"/>' : '<m:begChr m:val=""/>')
          + (n.close ? '<m:endChr m:val="' + escXml(n.close) + '"/>' : '<m:endChr m:val=""/>')
          + '<m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:dPr>'
          + '<m:e>' + ommlOf(n.items) + '</m:e></m:d>');
      case 'matrix': {
        var mc = '<m:mPr><m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:mPr>';
        var rows = n.rows.map(function (r) {
          return '<m:mr>' + r.map(function (c) { return '<m:e>' + ommlSlot(c) + '</m:e>'; }).join('') + '</m:mr>';
        }).join('');
        var tbl = '<m:m>' + mc + rows + '</m:m>';
        var env = MATRIX_ENVS[n.env];
        if (env && (env.open || env.close)) {
          return wrap('<m:d><m:dPr>'
            + (env.open ? '<m:begChr m:val="' + escXml(env.open) + '"/>' : '')
            + (env.close ? '<m:endChr m:val="' + escXml(env.close) + '"/>' : '')
            + '<m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:dPr>'
            + '<m:e>' + tbl + '</m:e></m:d>');
        }
        return wrap(tbl);
      }
      case 'accent': return wrap('<m:acc><m:accPr><m:chr m:val="' + escXml(n.chr) + '"/>'
        + '<m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:accPr>'
        + '<m:e>' + ommlSlot(n.body) + '</m:e></m:acc>');
      case 'under': return wrap('<m:limLow><m:limLowPr><m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:limLowPr>'
        + '<m:e>' + ommlSlot(n.body) + '</m:e>'
        + '<m:lim>' + ommlRun(n.chr, 'p') + '</m:lim></m:limLow>');
      case 'over': return wrap('<m:limUpp><m:limUppPr><m:ctrlPr><w:rPr>' + MATH_FONT + '</w:rPr></m:ctrlPr></m:limUppPr>'
        + '<m:e>' + ommlSlot(n.body) + '</m:e>'
        + '<m:lim>' + ommlRun(n.chr, 'p') + '</m:lim></m:limUpp>');
      case 'bb': {
        var s = '';
        for (var i = 0; i < n.v.length; i++) s += (BLACKBOARD[n.v.charAt(i)] || n.v.charAt(i));
        return wrap(ommlRun(s, 'p'), [{ t: s, s: 'p' }]);
      }
      case 'cal': {
        var s2 = '';
        for (var j = 0; j < n.v.length; j++) s2 += (CAL[n.v.charAt(j)] || n.v.charAt(j));
        return wrap(ommlRun(s2, 'i'), [{ t: s2, s: 'i' }]);
      }
      case 'root': return wrap(ommlOf(n.items));
      default: return null;
    }
  }

  /* 槽位内容：空槽必须显式给空 run，否则 Word 会认为公式结构缺损 */
  function ommlSlot(n) {
    if (!n || n.type === 'empty') return '<m:r><w:rPr>' + MATH_FONT + '</w:rPr><m:t/></m:r>';
    if (n.type === 'group') {
      var inner = ommlOf(n.items);
      return inner || '<m:r><w:rPr>' + MATH_FONT + '</w:rPr><m:t/></m:r>';
    }
    var piece = ommlNode(n);
    return piece ? piece.xml : '<m:r><w:rPr>' + MATH_FONT + '</w:rPr><m:t/></m:r>';
  }

  function mathToOmml(tex) {
    var ast = parse(tex);
    return '<m:oMath>' + ommlOf(ast.items) + '</m:oMath>';
  }

  function mathToOmmlPara(tex) {
    var ast = parse(tex);
    return '<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>'
      + '<m:oMath>' + ommlOf(ast.items) + '</m:oMath></m:oMathPara>';
  }

  /* ==================================================================
     六、文档层：Markdown → LaTeX
     ================================================================== */

  /* LaTeX 特殊字符转义。公式、代码、链接片段在这之前已换成占位符，
     不会经过这里 —— 否则 \textbf 里的反斜杠会被自己转义掉。 */
  function texEscape(s) {
    return String(s)
      .replace(/\\/g, '\u0003')
      .replace(/([#$%&_{}])/g, '\\$1')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}')
      .replace(/\u0003/g, '\\textbackslash{}');
  }

  var MD_LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function mdIsDelimRow(line) {
    return line.indexOf('-') >= 0 && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  }

  function mdSplitRow(line) {
    return line.replace(/^\s*\||\|\s*$/g, '').split('|').map(function (c) { return c.trim(); });
  }

  /* 行内元素 → LaTeX。顺序是关键：
     先用占位符摘出公式/代码/图片/链接，再转义普通文本，最后处理强调。
     这样强调产生的 \textbf 不会在后续步骤里被转义，而强调内部的文字
     已经在转义阶段处理过了。 */
  function inlineTex(s) {
    var holes = [];
    function hole(tex) { holes.push(tex); return '\u0001' + (holes.length - 1) + '\u0001'; }
    function escPath(u) { return String(u).replace(/([%#&_{}])/g, '\\$1'); }

    var t = String(s);

    t = t.replace(/\$([^$\n]+?)\$/g, function (m, body) { return hole('$' + body + '$'); });
    t = t.replace(/`([^`]+)`/g, function (m, c) { return hole('\\texttt{' + texEscape(c) + '}'); });
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, u) {
      return hole('\\includegraphics[width=0.9\\linewidth]{' + escPath(u) + '}');
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, u) {
      return hole('\\href{' + escPath(u) + '}{' + inlineTex(label) + '}');
    });
    /* 删除线也要在转义之前摘出来：~ 是 LaTeX 特殊字符，
       一旦先被转成 \textasciitilde{} 就再也认不出 ~~ 了。 */
    t = t.replace(/~~([^~]+)~~/g, function (m, c) { return hole('\\sout{' + texEscape(c) + '}'); });

    t = texEscape(t);

    t = t.replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
    t = t.replace(/__([^_]+)__/g, '\\textbf{$1}');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, function (m, p, a) { return p + '\\emph{' + a + '}'; });

    return t.replace(/\u0001(\d+)\u0001/g, function (m, i) { return holes[+i]; });
  }

  /* 列表缩进树 → 嵌套 itemize/enumerate。与索引页 HTML 渲染同源的算法，
     这里只是把输出从 <ul>/<ol> 换成 LaTeX 环境。 */
  function renderListTex(items, start, indent) {
    var buf = [];
    var cur = start;
    var open = null;
    while (cur < items.length) {
      var it = items[cur];
      if (it.indent < indent) break;
      if (it.indent > indent) {
        var sub = renderListTex(items, cur, it.indent);
        buf.push(sub.tex);
        cur = sub.next;
        continue;
      }
      var want = it.ordered ? 'enumerate' : 'itemize';
      if (open !== want) {
        if (open) buf.push('\\end{' + open + '}');
        buf.push('\\begin{' + want + '}');
        open = want;
      }
      buf.push('\\item ' + inlineTex(it.text));
      cur++;
    }
    if (open) buf.push('\\end{' + open + '}');
    return { tex: buf.join('\n'), next: cur };
  }

  var HEADING_CMD = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];

  /* Markdown → LaTeX 源码。opts.standalone=true 时只产出正文片段，
     否则包装成可直接用 xelatex 编译的完整文档。 */
  function mdToLatex(md, opts) {
    opts = opts || {};
    var warnings = [];
    var lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      /* --- 围栏代码块：内容原样进 verbatim，不做任何转义 --- */
      if (/^```([\w+-]*)\s*$/.test(line)) {
        i++;
        var code = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('\\begin{verbatim}\n' + code.join('\n') + '\n\\end{verbatim}');
        continue;
      }

      /* --- 块级公式 $$...$$ --- */
      if (/^\s*\$\$/.test(line)) {
        var first = line.replace(/^\s*\$\$/, '');
        var buf = [];
        if (/\$\$\s*$/.test(first)) {
          buf.push(first.replace(/\$\$\s*$/, ''));
          i++;
        } else {
          buf.push(first);
          i++;
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
          if (i < lines.length) { buf.push(lines[i].replace(/\$\$\s*$/, '')); i++; }
          else warnings.push('块级公式缺少收尾的 $$，已按原文收口');
        }
        out.push('\\[\n' + buf.join('\n').trim() + '\n\\]');
        continue;
      }

      /* --- 标题 --- */
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        out.push('\\' + HEADING_CMD[h[1].length - 1] + '{' + inlineTex(h[2]) + '}');
        i++;
        continue;
      }

      /* --- 分隔线 --- */
      if (/^(---|\*\*\*|___)\s*$/.test(line)) {
        out.push('\\begin{center}\\rule{0.85\\linewidth}{0.4pt}\\end{center}');
        i++;
        continue;
      }

      /* --- 表格 → tabular --- */
      if (line.trim().indexOf('|') >= 0 && i + 1 < lines.length && mdIsDelimRow(lines[i + 1])) {
        var header = mdSplitRow(line);
        var delim = mdSplitRow(lines[i + 1]);
        if (delim.length === header.length) {
          var aligns = delim.map(function (c) {
            if (/^:-+:$/.test(c)) return 'c';
            if (/^-+:$/.test(c)) return 'r';
            return 'l';
          });
          i += 2;
          var rows = [];
          while (i < lines.length && lines[i].trim() && lines[i].trim().indexOf('|') >= 0) {
            if (mdIsDelimRow(lines[i])) { i++; continue; }
            rows.push(mdSplitRow(lines[i]));
            i++;
          }
          var spec = '';
          for (var k = 0; k < header.length; k++) spec += '|' + aligns[k];
          spec += '|';
          var tb = ['\\begin{center}', '\\begin{tabular}{' + spec + '}', '\\hline'];
          tb.push(header.map(function (c) { return '\\textbf{' + inlineTex(c) + '}'; }).join(' & ') + ' \\\\');
          tb.push('\\hline');
          rows.forEach(function (r) {
            var cells = [];
            for (var q = 0; q < header.length; q++) cells.push(inlineTex(r[q] || ''));
            tb.push(cells.join(' & ') + ' \\\\');
            tb.push('\\hline');
          });
          tb.push('\\end{tabular}', '\\end{center}');
          out.push(tb.join('\n'));
          continue;
        }
      }

      /* --- 引用块（内部递归转换，支持嵌套结构） --- */
      if (/^>\s?/.test(line)) {
        var qb = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { qb.push(lines[i].replace(/^>\s?/, '')); i++; }
        var inner = mdToLatex(qb.join('\n'), { standalone: true });
        inner.warnings.forEach(function (w) { warnings.push(w); });
        out.push('\\begin{quote}\n' + inner.text + '\n\\end{quote}');
        continue;
      }

      /* --- 列表 --- */
      var lm = line.match(MD_LIST_RE);
      if (lm) {
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(MD_LIST_RE);
          if (!m) break;
          items.push({
            indent: m[1].replace(/\t/g, '    ').length,
            ordered: /^\d/.test(m[2]),
            text: m[3]
          });
          i++;
        }
        out.push(renderListTex(items, 0, items[0].indent).tex);
        continue;
      }

      /* --- 段落 --- */
      var pb = [line];
      i++;
      while (i < lines.length && lines[i].trim()
        && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
        && !/^(---|\*\*\*|___)\s*$/.test(lines[i]) && !/^>\s?/.test(lines[i])
        && !/^\s*\$\$/.test(lines[i]) && !MD_LIST_RE.test(lines[i])
        && lines[i].trim().indexOf('|') < 0) {
        pb.push(lines[i]); i++;
      }
      out.push(inlineTex(pb.join(' ')));
    }

    var body = out.join('\n\n');
    if (opts.standalone) return { text: body, warnings: warnings };

    var head = [
      '\\documentclass[11pt]{' + (opts.documentClass || 'ctexart') + '}',
      '\\usepackage[normalem]{ulem}',
      '\\usepackage{amsmath,amssymb,graphicx,hyperref,geometry}',
      '\\geometry{a4paper,margin=2.5cm}',
      opts.title ? '\\title{' + texEscape(opts.title) + '}' : '',
      opts.author ? '\\author{' + texEscape(opts.author) + '}' : '',
      '\\begin{document}',
      opts.title ? '\\maketitle' : ''
    ].filter(function (x) { return x !== ''; }).join('\n');

    return { text: head + '\n\n' + body + '\n\n\\end{document}\n', warnings: warnings };
  }

  /* 调试用：把 AST 摊平成可读文本，便于测试断言 */
  function astToText(tex) {
    function flat(n) {
      if (!n) return '';
      switch (n.type) {
        case 'empty': return '';
        case 'root': case 'group': return n.items.map(flat).join('');
        case 'num': case 'ident': case 'sym': case 'raw': return String(n.v);
        case 'func': return n.v;
        case 'text': return n.v;
        case 'bb': return n.v.split('').map(function (c) { return BLACKBOARD[c] || c; }).join('');
        case 'cal': return n.v.split('').map(function (c) { return CAL[c] || c; }).join('');
        case 'op': return n.chr;
        case 'space': return ' ';
        case 'sup': return flat(n.base) + '^' + flat(n.sup);
        case 'sub': return flat(n.base) + '_' + flat(n.sub);
        case 'subsup': return flat(n.base) + '_' + flat(n.sub) + '^' + flat(n.sup);
        case 'frac': return '(' + flat(n.num) + ')/(' + flat(n.den) + ')';
        case 'binom': return 'C(' + flat(n.num) + ',' + flat(n.den) + ')';
        case 'sqrt': return 'sqrt(' + flat(n.body) + ')';
        case 'nary': return n.chr + (n.sub ? '_' + flat(n.sub) : '') + (n.sup ? '^' + flat(n.sup) : '') + '{' + flat(n.body) + '}';
        case 'delim': return n.open + n.items.map(flat).join('') + n.close;
        case 'matrix': return n.rows.map(function (r) { return '[' + r.map(flat).join('&') + ']'; }).join(';');
        case 'accent': return flat(n.body) + n.chr;
        default: return '';
      }
    }
    return flat(parse(tex));
  }

  /* ==================================================================
     七、文档层：LaTeX → Markdown
     ================================================================== */

  /* 参数匹配：允许一层花括号嵌套，足以覆盖绝大多数真实文档 */
  var ARG = '\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}';

  /* 层级映射必须与 HEADING_CMD 严格对称，否则 md → tex → md 往返会逐次漂移
     （一级标题转过去再转回来就成了二级）。article 类里 \section 就是顶层章节。 */
  var SECTION_MD = {
    chapter: '#', section: '#', subsection: '##',
    subsubsection: '###', paragraph: '####', subparagraph: '#####'
  };

  /* 转换后仍会留在文本里的、不必告警的命令 */
  var BENIGN = {
    noindent: 1, newline: 1, linebreak: 1, par: 1, smallskip: 1, medskip: 1,
    bigskip: 1, hfill: 1, hrule: 1, vspace: 1, hspace: 1, centering: 1,
    makeatletter: 1, makeatother: 1, left: 1, right: 1,
    toprule: 1, midrule: 1, bottomrule: 1, hline: 1, cline: 1,
    documentclass: 1, usepackage: 1, begin: 1, end: 1, item: 1,
    maketitle: 1, tableofcontents: 1, newpage: 1, clearpage: 1, pagebreak: 1,
    label: 1, index: 1, vfill: 1, hfilll: 1, relax: 1
  };

  /* 行内命令 → Markdown 标记。循环到不动点，以便处理嵌套命令。 */
  function latexInline(s, warn) {
    var t = String(s);
    var rounds = 0;
    var changed = true;

    function rep(re, fn) {
      t = t.replace(re, function () {
        changed = true;
        return fn.apply(null, arguments);
      });
    }

    while (changed && rounds++ < 15) {
      changed = false;

      rep(new RegExp('\\\\(?:textbf|bf|strong|mathbf)\\s*' + ARG, 'g'), function (m, b) { return '**' + b + '**'; });
      rep(new RegExp('\\\\(?:emph|textit|it|textsl|textsc)\\s*' + ARG, 'g'), function (m, b) { return '*' + b + '*'; });
      rep(new RegExp('\\\\(?:texttt|lstinline)\\s*' + ARG, 'g'), function (m, b) { return '`' + b + '`'; });
      rep(new RegExp('\\\\(?:text|mbox|textrm|textsf|textnormal|underline|mathrm)\\s*' + ARG, 'g'), function (m, b) { return b; });
      rep(new RegExp('\\\\href\\s*' + ARG + '\\s*' + ARG, 'g'), function (m, u, label) { return '[' + label + '](' + u + ')'; });
      rep(new RegExp('\\\\url\\s*' + ARG, 'g'), function (m, u) { return '<' + u + '>'; });
      rep(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, function (m, u) {
        return '![' + (String(u).split('/').pop() || '') + '](' + u + ')';
      });
      rep(new RegExp('\\\\footnote\\s*' + ARG, 'g'), function (m, b) { return '[^ ' + b + ']'; });
      rep(new RegExp('\\\\(?:ref|eqref|autoref|cref|Cref)\\s*' + ARG, 'g'), function (m, k) { return '[ref: ' + k + ']'; });
      rep(new RegExp('\\\\cite[tp]?\\s*(?:\\[[^\\]]*\\])?\\s*' + ARG, 'g'), function (m, k) { return '[cite: ' + k + ']'; });
      rep(new RegExp('\\\\label\\s*' + ARG, 'g'), function () { return ''; });
      rep(new RegExp('\\\\caption\\s*' + ARG, 'g'), function (m, b) { return '*' + b + '*'; });
    }
    return t;
  }

  /* tabular → Markdown 表格。必须在行内命令处理之前跑，
     否则 & 与 \\ 的原始结构会被破坏。 */
  function latexTabular(s, warn) {
    return String(s).replace(
      /\\begin\{(tabular|tabularx|array)\}([\s\S]*?)\\end\{\1\}/g,
      function (m, env, inner) {
        /* 环境名后可能跟 0~2 个 {...} 参数（tabularx 的宽度、array 的列格式），
           逐个剥掉，最后一个才是列格式。用捕获组直接匹配参数个数会被
           贪婪吃掉，所以改成手工剥。 */
        var args = [];
        var rest = inner;
        var am;
        while ((am = /^\s*\{([^{}]*)\}/.exec(rest))) {
          args.push(am[1]);
          rest = rest.slice(am[0].length);
        }
        var spec = args.length ? args[args.length - 1] : '';
        var ncol = (spec.match(/[lcrpmbX]/g) || []).length;
        if (!ncol) { warn('tabular 列格式无法识别，已保留 LaTeX 原文'); return m; }

        var rows = [];
        rest.split(/\\\\/).forEach(function (chunk) {
          var line = chunk
            .replace(/\\(?:hline|toprule|midrule|bottomrule)\b/g, '')
            .replace(/\\cline\s*\{[^}]*\}/g, '')
            .trim();
          if (!line) return;
          rows.push(line.split('&').map(function (c) { return c.trim(); }));
        });
        if (!rows.length) return m;

        var md = [];
        var head = [];
        var q;
        for (q = 0; q < ncol; q++) head.push(rows[0][q] || '');
        md.push('| ' + head.join(' | ') + ' |');
        md.push('| ' + head.map(function () { return '---'; }).join(' | ') + ' |');
        for (var r = 1; r < rows.length; r++) {
          var cells = [];
          for (q = 0; q < ncol; q++) cells.push(rows[r][q] || '');
          md.push('| ' + cells.join(' | ') + ' |');
        }
        return '\n' + md.join('\n') + '\n';
      });
  }

  /* itemize / enumerate → Markdown 列表，按环境嵌套深度缩进 */
  function latexLists(s) {
    var lines = String(s).split('\n');
    var out = [];
    var stack = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var t = raw.trim();
      if (/^\\begin\{(itemize|enumerate|description)\}/.test(t)) {
        stack.push({ type: /enumerate/.test(t) ? 'enumerate' : 'itemize', n: 0 });
        continue;
      }
      if (/^\\end\{(itemize|enumerate|description)\}/.test(t)) {
        if (stack.length) stack.pop();
        continue;
      }
      var mi = /^\\item(\[[^\]]*\])?\s*([\s\S]*)$/.exec(t);
      if (mi && stack.length) {
        var top = stack[stack.length - 1];
        top.n++;
        var pad = new Array(stack.length).join('  ');
        var bullet = top.type === 'enumerate' ? (top.n + '. ') : '- ';
        out.push(pad + bullet + mi[2]);
        continue;
      }
      /* \item 的续行（多段说明）缩进到内容层 */
      if (stack.length && t) {
        out.push(new Array(stack.length).join('  ') + '  ' + t);
        continue;
      }
      out.push(raw);
    }
    return out.join('\n');
  }

  /* LaTeX → Markdown。尽力双向：能认的认，认不出的原样保留并进告警清单，
     绝不静默丢内容。 */
  function latexToMd(src) {
    var warnings = [];
    var seen = {};
    function warn(name) {
      if (seen[name]) return;
      seen[name] = 1;
      warnings.push(name);
    }

    var s = String(src == null ? '' : src).replace(/\r\n/g, '\n');

    /* 1. 去注释：% 到行尾，但 \% 是转义的字面百分号 */
    s = s.replace(/(^|[^\\])%[^\n]*/g, '$1');

    /* 2. 只取 document 环境内的正文 */
    var dm = /\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}/.exec(s);
    if (dm) s = dm[1];

    /* 3. verbatim 原文先摘出来，免得被后面的规则改写 */
    var verbatim = [];
    s = s.replace(/\\begin\s*\{(verbatim|lstlisting|minted)\}(?:\{[^{}]*\})?([\s\S]*?)\\end\s*\{\1\}/g,
      function (m, env, body) {
        verbatim.push(body.replace(/^\n/, '').replace(/\n$/, ''));
        return '\u0002' + (verbatim.length - 1) + '\u0002';
      });

    /* 4. 数学环境 → $$ 围栏 */
    s = s.replace(/\\begin\s*\{(equation\*?|displaymath|align\*?|gather\*?|eqnarray\*?|multline\*?|flalign\*?)\}([\s\S]*?)\\end\s*\{\1\}/g,
      function (m, env, body) {
        var b = body.trim();
        if (/^(align|flalign|eqnarray)/.test(env)) b = '\\begin{aligned}\n' + b + '\n\\end{aligned}';
        return '\n\n$$\n' + b + '\n$$\n\n';
      });
    s = s.replace(/\\\[([\s\S]*?)\\\]/g, function (m, b) { return '\n\n$$\n' + b.trim() + '\n$$\n\n'; });
    s = s.replace(/\\\(([\s\S]*?)\\\)/g, function (m, b) { return '$' + b.trim() + '$'; });

    /* 5. 章节命令 → 标题 */
    Object.keys(SECTION_MD).forEach(function (name) {
      s = s.replace(new RegExp('\\\\' + name + '\\*?\\s*' + ARG, 'g'), function (m, body) {
        return '\n\n' + SECTION_MD[name] + ' ' + latexInline(body, warn) + '\n\n';
      });
    });

    /* 6. 表格与列表 —— 都依赖 & / \\ / \item 的原始结构，故在行内命令之前 */
    s = latexTabular(s, warn);
    s = latexLists(s);

    /* 7. 引用、居中、图表环境 */
    s = s.replace(/\\begin\{(quote|quotation)\}([\s\S]*?)\\end\{\1\}/g, function (m, env, body) {
      return '\n\n' + body.trim().split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
    });
    s = s.replace(/\\begin\{(center|flushleft|flushright|abstract|small|footnotesize)\}([\s\S]*?)\\end\{\1\}/g,
      function (m, env, body) { return '\n\n' + body.trim() + '\n\n'; });
    s = s.replace(/\\begin\{(figure\*?|table\*?)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g,
      function (m, env, body) { return '\n\n' + body.trim() + '\n\n'; });

    /* 8. 标题与作者 */
    s = s.replace(new RegExp('\\\\title\\s*' + ARG, 'g'), function (m, b) { return '# ' + latexInline(b, warn); });
    s = s.replace(new RegExp('\\\\author\\s*' + ARG, 'g'), function () { return ''; });
    s = s.replace(/\\date\s*\{[^{}]*\}/g, '');
    s = s.replace(/\\maketitle\b/g, '');

    /* 9. 行内命令 */
    s = latexInline(s, warn);

    /* 10. 剩余的换行命令 */
    s = s.replace(/\\\\(?:\s*\[[^\]]*\])?/g, '  \n');

    /* 11. 还原转义字符 */
    s = s.replace(/\\textbackslash\{\}/g, '\\')
      .replace(/\\textasciitilde\{\}/g, '~')
      .replace(/\\textasciicircum\{\}/g, '^')
      .replace(/\\\$/g, '$')
      .replace(/\\([#$%&_{}])/g, '$1');

    /* 12. 还原 verbatim */
    s = s.replace(/\u0002(\d+)\u0002/g, function (m, i) {
      return '```\n' + verbatim[+i] + '\n```';
    });

    /* 13. 收尾：清行尾空白、压缩连续空行 */
    s = s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

    /* 14. 扫描剩余命令进告警清单 */
    (s.match(/\\[a-zA-Z]+/g) || []).forEach(function (c) {
      var name = c.slice(1);
      if (!BENIGN[name]) warn(name);
    });

    return { text: s + '\n', warnings: warnings };
  }

  return {
    /* 数学层 */
    parse: parse,
    astToText: astToText,
    mathToMathML: mathToMathML,
    mathToOmml: mathToOmml,
    mathToOmmlPara: mathToOmmlPara,
    /* 文档层 */
    mdToLatex: mdToLatex,
    latexToMd: latexToMd
  };
});
