/* docxread.js — 读取 .docx / .doc 并反向转换为 Markdown（零第三方依赖、离线可用）
   浏览器、Electron 渲染进程与 Node 均可运行，风格与 docxgen.js / texconv.js 保持一致。

   三条能力：
   ┌ ZIP 解包：.docx 本质是 ZIP。用 DecompressionStream('deflate-raw') 解压，
   │           不引第三方库；带 Zip64 兜底（超大文档的目录项会溢出 32 位）。
   ├ OOXML → Markdown：解析 word/document.xml，还原标题、粗斜体、上下标、列表、
   │           表格、超链接、图片与公式；公式按 OMML 结构还原为 LaTeX，
   │           交回 texconv 复用同一条渲染/导出链路。
   └ .doc 兜底：旧版二进制 .doc 是 OLE 复合文档，明确报错并引导另存为 .docx；
               HTML 形态的 .doc（本工具自己的导出格式）按 HTML 转 Markdown。

   设计取舍：认不出的结构一律降级为「可见的文本」而不是静默丢弃，
   与 texconv 里 \foo 的降级策略一致；有损之处进 warnings，让调用方能提示用户。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.docxread = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==================================================================
     一、字节与编码
     ================================================================== */

  function u8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(bytes || []);
  }

  function isZip(b) {
    var x = u8(b);
    return x.length > 3 && x[0] === 0x50 && x[1] === 0x4B
      && (x[2] === 0x03 || x[2] === 0x05 || x[2] === 0x07);
  }

  /* OLE 复合文档（.doc/.xls/.ppt 的旧版二进制容器）魔数 */
  function isOle(b) {
    var x = u8(b);
    return x.length > 3 && x[0] === 0xD0 && x[1] === 0xCF && x[2] === 0x11 && x[3] === 0xE0;
  }

  function decodeText(bytes) {
    var b = u8(bytes);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    var utf8 = new TextDecoder('utf-8').decode(b);
    /* 出现替换符说明不是 UTF-8；中文 Windows 上的老文件多为 GBK */
    if (utf8.indexOf('\uFFFD') >= 0) {
      try { return new TextDecoder('gbk').decode(b); } catch (e) { /* 保持 UTF-8 结果 */ }
    }
    return utf8;
  }

  /* ==================================================================
     二、ZIP 解包
     ================================================================== */

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'function') {
      try {
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) {
        /* 少数不规范打包器写的是带 zlib 头的 deflate，下面再试一次 */
      }
    }
    if (typeof require === 'function') {
      var zlib = require('zlib');
      try { return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes))); }
      catch (e) { return new Uint8Array(zlib.inflateSync(Buffer.from(bytes))); }
    }
    throw new Error('当前环境不支持解压（缺少 DecompressionStream）');
  }

  function zipName(bytes, flag) {
    if (flag & 0x0800) return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* 解析中央目录，返回 { 文件名: { method, raw, size } } —— 原始压缩数据，按需解压 */
  function unzip(input) {
    var buf = u8(input);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    var eocd = -1;
    var floor = Math.max(0, buf.length - 22 - 65535);
    for (var i = buf.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/docx：找不到中央目录结尾');

    var count = dv.getUint16(eocd + 10, true);
    var cdSize = dv.getUint32(eocd + 12, true);
    var cdOff = dv.getUint32(eocd + 16, true);

    /* Zip64：32 位字段写满 0xFF.. 时改读 Zip64 目录结尾 */
    if (cdOff === 0xFFFFFFFF || count === 0xFFFF || cdSize === 0xFFFFFFFF) {
      var loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        var z64 = Number(dv.getBigUint64(loc + 8, true));
        if (z64 + 56 <= buf.length && dv.getUint32(z64, true) === 0x06064b50) {
          count = Number(dv.getBigUint64(z64 + 32, true));
          cdSize = Number(dv.getBigUint64(z64 + 40, true));
          cdOff = Number(dv.getBigUint64(z64 + 48, true));
        }
      }
    }

    var files = {};
    var p = cdOff;
    for (var n = 0; n < count; n++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) break;
      var flag = dv.getUint16(p + 8, true);
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true);
      var elen = dv.getUint16(p + 30, true);
      var clen = dv.getUint16(p + 32, true);
      var loff = dv.getUint32(p + 42, true);
      var name = zipName(buf.subarray(p + 46, p + 46 + nlen), flag);

      if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || loff === 0xFFFFFFFF) {
        var ex = p + 46 + nlen;
        var exEnd = ex + elen;
        while (ex + 4 <= exEnd) {
          var hid = dv.getUint16(ex, true);
          var hsz = dv.getUint16(ex + 2, true);
          if (hid === 0x0001) {
            var q = ex + 4;
            if (usize === 0xFFFFFFFF && q + 8 <= exEnd) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (csize === 0xFFFFFFFF && q + 8 <= exEnd) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (loff === 0xFFFFFFFF && q + 8 <= exEnd) { loff = Number(dv.getBigUint64(q, true)); q += 8; }
          }
          ex += 4 + hsz;
        }
      }

      if (loff + 30 > buf.length || dv.getUint32(loff, true) !== 0x04034b50) {
        throw new Error('ZIP 局部文件头损坏：' + name);
      }
      var lnlen = dv.getUint16(loff + 26, true);
      var lelen = dv.getUint16(loff + 28, true);
      var dstart = loff + 30 + lnlen + lelen;
      files[name] = { method: method, raw: buf.subarray(dstart, dstart + csize), size: usize };
      p += 46 + nlen + elen + clen;
    }
    return files;
  }

  function findEntry(files, name) {
    if (files[name]) return files[name];
    var lower = String(name).toLowerCase();
    var keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) return files[keys[i]];
    }
    return null;
  }

  async function entryBytes(files, name) {
    var e = findEntry(files, name);
    if (!e) return null;
    return e.method === 0 ? e.raw : await inflateRaw(e.raw);
  }

  async function entryText(files, name) {
    var b = await entryBytes(files, name);
    return b == null ? null : decodeText(b);
  }

  /* ==================================================================
     三、极简 XML 解析器
     只需要「元素 / 属性 / 直接文本」三样东西，就足够读 OOXML。
     自己写而不是用 DOMParser，是为了让本模块在 Node 里也能跑（测试用）。
     ================================================================== */

  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body] || m;
    });
  }

  function parseAttrs(s) {
    var attrs = {};
    var re = /([\w:.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    while ((m = re.exec(s))) attrs[m[1]] = decodeEntities(m[2] != null ? m[2] : m[3]);
    return attrs;
  }

  function tagEnd(src, from) {
    var quote = 0;
    for (var i = from + 1; i < src.length; i++) {
      var c = src.charAt(i);
      if (quote) { if (c === quote) quote = 0; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') return i;
    }
    return -1;
  }

  /* HTML 的空元素与行内元素表：宽松解析只在 opts.html 时启用 */
  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };
  var INLINE_TAGS = {
    a: 1, abbr: 1, b: 1, big: 1, br: 1, cite: 1, code: 1, del: 1, em: 1, font: 1,
    i: 1, img: 1, kbd: 1, label: 1, mark: 1, q: 1, s: 1, samp: 1, small: 1,
    span: 1, strike: 1, strong: 1, sub: 1, sup: 1, time: 1, tt: 1, u: 1, var: 1
  };

  /* 浏览器会隐式收尾的几种情况；不补这些，真实网页的树会整棵嵌套错位 */
  function autoClosed(top, next) {
    if (top === 'p' && !INLINE_TAGS[next]) return true;
    if (top === 'li' && next === 'li') return true;
    if ((top === 'td' || top === 'th') && (next === 'td' || next === 'th' || next === 'tr')) return true;
    if (top === 'tr' && next === 'tr') return true;
    if (top === 'option' && next === 'option') return true;
    if ((top === 'dt' || top === 'dd') && (next === 'dt' || next === 'dd')) return true;
    return false;
  }

  function parseXml(src, opts) {
    var html = !!(opts && opts.html);
    var s = String(src == null ? '' : src);
    var i = 0;
    var n = s.length;
    var stack = [];
    var root = null;

    function addText(txt, raw) {
      if (!stack.length || !txt) return;
      var text = raw ? txt : decodeEntities(txt);
      var top = stack[stack.length - 1];
      top.text += text;
      /* 文本同时作为子节点保留：HTML 必须按文档顺序还原「文字 / 标签」的交错 */
      top.children.push({ name: '#text', attrs: {}, children: [], text: text });
    }

    while (i < n) {
      var lt = s.indexOf('<', i);
      if (lt < 0) { addText(s.slice(i), false); break; }
      if (lt > i) addText(s.slice(i, lt), false);

      if (s.substr(lt, 4) === '<!--') {
        var ce = s.indexOf('-->', lt);
        i = ce < 0 ? n : ce + 3;
        continue;
      }
      if (s.substr(lt, 9) === '<![CDATA[') {
        var cde = s.indexOf(']]>', lt);
        addText(s.slice(lt + 9, cde < 0 ? n : cde), true);
        i = cde < 0 ? n : cde + 3;
        continue;
      }
      if (s.substr(lt, 2) === '<?') { var pe = s.indexOf('?>', lt); i = pe < 0 ? n : pe + 2; continue; }
      if (s.substr(lt, 2) === '<!') { var de = s.indexOf('>', lt); i = de < 0 ? n : de + 1; continue; }

      var gt = tagEnd(s, lt);
      if (gt < 0) break;
      var inner = s.slice(lt + 1, gt);
      var selfClose = inner.charAt(inner.length - 1) === '/';
      if (selfClose) inner = inner.slice(0, -1);

      if (inner.charAt(0) === '/') {
        var closeName = inner.slice(1).trim();
        for (var k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === closeName) { stack.length = k; break; }
        }
        i = gt + 1;
        continue;
      }

      var sp = inner.search(/\s/);
      var name = sp < 0 ? inner : inner.slice(0, sp);
      if (html) name = name.toLowerCase();
      var node = { name: name, attrs: parseAttrs(sp < 0 ? '' : inner.slice(sp + 1)), children: [], text: '' };

      if (html) {
        while (stack.length && autoClosed(stack[stack.length - 1].name, name)) stack.pop();
        if (VOID_TAGS[name]) selfClose = true;
      }

      if (stack.length) {
        stack[stack.length - 1].children.push(node);
      } else if (html) {
        /* HTML 片段可能没有单一根（多个并列顶层元素），用合成根兜住，否则会丢内容 */
        if (!root) root = { name: '#root', attrs: {}, children: [], text: '' };
        root.children.push(node);
      } else if (!root) {
        root = node;
      }
      if (!selfClose) stack.push(node);
      i = gt + 1;
    }
    return root;
  }

  function localName(name) {
    var i = String(name).indexOf(':');
    return i < 0 ? String(name) : String(name).slice(i + 1);
  }

  function attr(node, name) {
    if (!node || !node.attrs) return null;
    if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
    var want = localName(name);
    for (var k in node.attrs) {
      if (Object.prototype.hasOwnProperty.call(node.attrs, k) && localName(k) === want) return node.attrs[k];
    }
    return null;
  }

  function childrenOf(node, name) {
    if (!node) return [];
    var want = localName(name);
    return node.children.filter(function (c) { return localName(c.name) === want; });
  }

  function firstChild(node, name) {
    if (!node) return null;
    var want = localName(name);
    for (var i = 0; i < node.children.length; i++) {
      if (localName(node.children[i].name) === want) return node.children[i];
    }
    return null;
  }

  function findDeep(node, name) {
    if (!node) return null;
    if (localName(node.name) === localName(name)) return node;
    for (var i = 0; i < node.children.length; i++) {
      var hit = findDeep(node.children[i], name);
      if (hit) return hit;
    }
    return null;
  }

  function indentOf(level) {
    var s = '';
    for (var i = 0; i < level; i++) s += '  ';
    return s;
  }

  /* ==================================================================
     四、OMML（Word 公式）→ LaTeX
     Word 把公式存成 OMML 树。这里只还原常用结构，认不出的节点递归取其
     子内容，保证字符不丢 —— 转不成 \frac 也好过整条公式消失。
     ================================================================== */

  var NARY_BACK = {
    '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '⋃': '\\bigcup', '⋂': '\\bigcap',
    '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⨀': '\\bigodot', '⋁': '\\bigvee',
    '⋀': '\\bigwedge', '⨆': '\\bigsqcup', '⨄': '\\biguplus',
    '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint'
  };

  /* \lim / \max 这类「文字型」大运算符：m:chr 存的是文字而非符号，需补回命令名 */
  var LIM_BACK = {
    'lim': '\\lim', 'lim sup': '\\limsup', 'lim inf': '\\liminf',
    'max': '\\max', 'min': '\\min', 'sup': '\\sup', 'inf': '\\inf',
    'det': '\\det', 'gcd': '\\gcd', 'Pr': '\\Pr', 'lcm': '\\lcm'
  };

  var ACCENT_BACK = {
    '\u0302': '\\hat', '\u0303': '\\tilde', '\u0304': '\\bar', '\u0305': '\\bar',
    /* U+203E / U+00AF：旧版本导出用过的间隔上划线字符，兼容读回 */
    '\u203E': '\\bar', '\u00AF': '\\bar',
    '\u20D7': '\\vec', '\u0307': '\\dot', '\u0308': '\\ddot', '\u0301': '\\acute',
    '\u0300': '\\grave', '\u030C': '\\check', '\u0306': '\\breve'
  };

  /* 数学文本转义：只处理真正会破坏 LaTeX 的字符，^ ~ 保持原样（它们本身就是运算符） */
  function mtex(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\backslash ')
      .replace(/([{}])/g, '\\$1')
      .replace(/\$/g, '\\$')
      .replace(/&/g, '\\&')
      .replace(/#/g, '\\#')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
  }

  function delimTex(ch) {
    if (!ch) return '.';
    if (ch === '{') return '\\{';
    if (ch === '}') return '\\}';
    if (ch === '⟨') return '\\langle';
    if (ch === '⟩') return '\\rangle';
    if (ch === '‖') return '\\|';
    if (ch === '⌈') return '\\lceil';
    if (ch === '⌉') return '\\rceil';
    if (ch === '⌊') return '\\lfloor';
    if (ch === '⌋') return '\\rfloor';
    return ch;
  }

  function ommlNodes(n) {
    var out = '';
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      /* 所有 *Pr 都是属性容器，不含内容 */
      if (/Pr$/.test(localName(c.name))) continue;
      out += ommlNode(c);
    }
    return out;
  }

  function ommlChild(n, name) {
    var c = firstChild(n, name);
    return c ? ommlNode(c) : '';
  }

  function ommlRun(n) {
    var text = '';
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (localName(c.name) === 't') text += c.text;
    }
    if (!text) return '';
    var sty = firstChild(n, 'rPr');
    var val = sty ? attr(firstChild(sty, 'sty'), 'm:val') : null;
    /* 正体（\mathrm）只对多字符有意义：单字符 p 样式在 Word 里也是斜体变量 */
    if (val === 'p' && text.length > 1) return '\\mathrm{' + mtex(text) + '}';
    return mtex(text);
  }

  function ommlNode(n) {
    if (!n) return '';
    switch (localName(n.name)) {
      case 'oMath': case 'oMathPara': case 'e': case 'num': case 'den':
      case 'sub': case 'sup': case 'deg': case 'lim': case 'fName':
        return ommlNodes(n);
      case 'r': return ommlRun(n);
      case 't': case '#text': return mtex(n.text);
      case 'f':
        return '\\frac{' + ommlChild(n, 'num') + '}{' + ommlChild(n, 'den') + '}';
      case 'sSup': return ommlChild(n, 'e') + '^{' + ommlChild(n, 'sup') + '}';
      case 'sSub': return ommlChild(n, 'e') + '_{' + ommlChild(n, 'sub') + '}';
      case 'sSubSup':
        return ommlChild(n, 'e') + '_{' + ommlChild(n, 'sub') + '}^{' + ommlChild(n, 'sup') + '}';
      case 'sPre':
        return '^{' + ommlChild(n, 'sup') + '}_{' + ommlChild(n, 'sub') + '}' + ommlChild(n, 'e');
      case 'rad': {
        var deg = ommlChild(n, 'deg');
        var radBody = ommlChild(n, 'e');
        return deg ? '\\sqrt[' + deg + ']{' + radBody + '}' : '\\sqrt{' + radBody + '}';
      }
      case 'nary': {
        var pr = firstChild(n, 'naryPr');
        var chrEl = pr ? firstChild(pr, 'chr') : null;
        var chr = chrEl ? (attr(chrEl, 'm:val') || '') : '';
        if (!chr) chr = '∑';
        var op = NARY_BACK[chr] || LIM_BACK[chr] || chr;
        var sub = ommlChild(n, 'sub');
        var sup = ommlChild(n, 'sup');
        var out = op;
        if (sub) out += '_{' + sub + '}';
        if (sup) out += '^{' + sup + '}';
        var body = ommlChild(n, 'e');
        return body ? out + ' ' + body : out;
      }
      case 'd': {
        var dpr = firstChild(n, 'dPr');
        var beg = '(', end = ')';
        if (dpr) {
          var b = firstChild(dpr, 'begChr');
          var e2 = firstChild(dpr, 'endChr');
          if (b) beg = attr(b, 'm:val') || '';
          if (e2) end = attr(e2, 'm:val') || '';
        }
        var inner = childrenOf(n, 'e').map(ommlNode).join('');
        return '\\left' + delimTex(beg) + inner + '\\right' + delimTex(end);
      }
      case 'acc': {
        var accPr = firstChild(n, 'accPr');
        var accChr = accPr ? attr(firstChild(accPr, 'chr'), 'm:val') : null;
        var cmd = ACCENT_BACK[accChr] || '\\hat';
        return cmd + '{' + ommlChild(n, 'e') + '}';
      }
      case 'bar': {
        var barPr = firstChild(n, 'barPr');
        var pos = barPr ? attr(firstChild(barPr, 'pos'), 'm:val') : null;
        var barCmd = pos === 'bot' ? '\\underline' : '\\overline';
        return barCmd + '{' + ommlChild(n, 'e') + '}';
      }
      case 'limLow': {
        var lim = ommlChild(n, 'lim');
        var low = ommlChild(n, 'e');
        return lim ? low + '_{' + lim + '}' : low;
      }
      case 'limUpp': {
        var lim2 = ommlChild(n, 'lim');
        var upp = ommlChild(n, 'e');
        return lim2 ? upp + '^{' + lim2 + '}' : upp;
      }
      case 'func': {
        var fname = ommlChild(n, 'fName');
        var fbody = ommlChild(n, 'e');
        return fname + (fbody ? ' ' + fbody : '');
      }
      case 'groupChr': {
        var gPr = firstChild(n, 'groupChrPr');
        var gChr = gPr ? attr(firstChild(gPr, 'chr'), 'm:val') : null;
        var gBody = ommlChild(n, 'e');
        if (gChr === '⏟') return '\\underbrace{' + gBody + '}';
        if (gChr === '⏞') return '\\overbrace{' + gBody + '}';
        return gBody;
      }
      case 'm': {
        var rows = childrenOf(n, 'mr').map(function (mr) {
          return childrenOf(mr, 'e').map(ommlNode).join(' & ');
        });
        return '\\begin{matrix} ' + rows.join(' \\\\ ') + ' \\end{matrix}';
      }
      case 'eqArr': {
        var arows = childrenOf(n, 'e').map(ommlNode);
        return '\\begin{aligned} ' + arows.join(' \\\\ ') + ' \\end{aligned}';
      }
      case 'box': case 'borderBox': case 'phant': case 'groupChrPr':
        return ommlChild(n, 'e') || ommlNodes(n);
      default:
        return ommlNodes(n);
    }
  }

  function ommlToLatex(node) {
    return ommlNode(node);
  }

  /* ==================================================================
     五、OOXML → Markdown
     ================================================================== */

  var HEADING_CN = /^标题\s*([1-9])$/;

  function headingLevel(pPr) {
    if (!pPr) return 0;
    var style = firstChild(pPr, 'pStyle');
    var id = style ? attr(style, 'w:val') : null;
    if (id) {
      var m = /^heading\s*([1-9])$/i.exec(id) || /^([1-9])$/.exec(id) || HEADING_CN.exec(id);
      if (m) return Math.min(6, parseInt(m[1], 10));
    }
    var outline = firstChild(pPr, 'outlineLvl');
    if (outline) {
      var lv = parseInt(attr(outline, 'w:val'), 10);
      if (isFinite(lv)) return Math.min(6, lv + 1);
    }
    return 0;
  }

  function runStyle(rPr) {
    var st = { bold: false, italic: false, strike: false, vert: null };
    if (!rPr) return st;
    var b = firstChild(rPr, 'b');
    if (b && attr(b, 'w:val') !== '0' && attr(b, 'w:val') !== 'false') st.bold = true;
    var i = firstChild(rPr, 'i');
    if (i && attr(i, 'w:val') !== '0' && attr(i, 'w:val') !== 'false') st.italic = true;
    if (firstChild(rPr, 'strike') || firstChild(rPr, 'dstrike')) st.strike = true;
    var va = firstChild(rPr, 'vertAlign');
    if (va) {
      var v = attr(va, 'w:val');
      if (v === 'superscript' || v === 'subscript') st.vert = v;
    }
    return st;
  }

  function symChar(node) {
    var hex = attr(node, 'w:char');
    if (!hex) return '';
    var code = parseInt(hex, 16);
    if (!isFinite(code)) return '';
    /* Word 把符号存在私用区 F0xx，减 F000 即真实字符码 */
    if (code >= 0xF000 && code <= 0xF0FF) code -= 0xF000;
    try { return String.fromCodePoint(code); } catch (e) { return ''; }
  }

  function drawingToMarkdown(node, ctx) {
    var blip = findDeep(node, 'blip');
    var rid = blip ? (attr(blip, 'r:embed') || attr(blip, 'r:link')) : null;
    var target = rid ? ctx.rels[rid] : '';
    if (!target) return '';
    var docPr = findDeep(node, 'docPr');
    var alt = docPr ? (attr(docPr, 'descr') || attr(docPr, 'name') || '') : '';
    ctx.images++;
    return '![' + alt + '](' + target + ')';
  }

  function runToMarkdown(r, ctx) {
    var st = runStyle(firstChild(r, 'rPr'));
    var inner = '';
    for (var i = 0; i < r.children.length; i++) {
      var c = r.children[i];
      switch (localName(c.name)) {
        case 't': inner += c.text; break;
        case 'delText': break;                       /* 修订删除的内容不导出 */
        case 'tab': inner += '\t'; break;
        case 'br': inner += '  \n'; break;           /* Markdown 硬换行 */
        case 'noBreakHyphen': inner += '-'; break;
        case 'sym': inner += symChar(c); break;
        case 'drawing': case 'pict': inner += drawingToMarkdown(c, ctx); break;
        case 'oMath': inner += '$' + ommlToLatex(c) + '$'; break;
        default: break;
      }
    }
    if (!inner) return '';
    var t = inner;
    if (st.vert) {
      t = '$' + (st.vert === 'superscript' ? '^{' : '_{') + t + '}$';
      if (!ctx.vertWarned) { ctx.vertWarned = true; ctx.warnings.push('上标/下标已转为行内公式'); }
    }
    if (st.strike) t = '~~' + t + '~~';
    if (st.italic) t = '*' + t + '*';
    if (st.bold) t = '**' + t + '**';
    return t;
  }

  function inlineOf(node, ctx) {
    var out = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      switch (localName(c.name)) {
        case 'r': out += runToMarkdown(c, ctx); break;
        case 'hyperlink': {
          var target = ctx.rels[attr(c, 'r:id')] || '';
          var label = inlineOf(c, ctx);
          if (!label) break;
          out += target ? '[' + label + '](' + target + ')' : label;
          break;
        }
        case 'ins': out += inlineOf(c, ctx); break;
        case 'del': break;                            /* 修订删除：整段丢弃 */
        case 'sdt': case 'sdtContent': case 'smartTag':
        case 'dir': case 'bdo': case 'fldSimple':
          out += inlineOf(c, ctx);
          break;
        case 'oMath': out += '$' + ommlToLatex(c) + '$'; break;
        case 'oMathPara': out += '$$\n' + ommlToLatex(c) + '\n$$'; break;
        default: break;
      }
    }
    return out;
  }

  function paragraphInfo(p, ctx, plain) {
    var pPr = firstChild(p, 'pPr');
    var level = plain ? 0 : headingLevel(pPr);
    var list = null;
    if (!plain && !level && ctx.numbering) {
      var numPr = firstChild(pPr, 'numPr');
      if (numPr) {
        var numId = attr(firstChild(numPr, 'numId'), 'w:val');
        var ilvl = attr(firstChild(numPr, 'ilvl'), 'w:val');
        if (numId && numId !== '0') {
          var level2 = parseInt(ilvl, 10);
          if (!isFinite(level2) || level2 < 0) level2 = 0;
          var ordered = ctx.numbering.isOrdered(numId, level2);
          list = {
            indent: indentOf(level2),
            marker: ordered ? ctx.numbering.nextIndex(numId, level2) + '.' : '-'
          };
        }
      }
    }
    var text = inlineOf(p, ctx).replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, '');
    return { level: level, list: list, text: text };
  }

  function cellToMarkdown(tc, ctx) {
    var parts = childrenOf(tc, 'p').map(function (p) {
      return paragraphInfo(p, ctx, true).text;
    }).filter(function (s) { return s !== ''; });
    if (childrenOf(tc, 'tbl').length) parts.push('[嵌套表格已省略]');
    return parts.join('<br>').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  }

  /* 只剥掉「整格被粗体包住」的情况，格内混排（a<br>b）保持原样 */
  function stripCellBold(s) {
    var m = /^\*\*([^*]+)\*\*$/.exec(String(s).trim());
    return m ? m[1] : s;
  }

  function tableToMarkdown(tbl, ctx) {
    var rows = childrenOf(tbl, 'tr').map(function (tr) {
      return childrenOf(tr, 'tc').map(function (tc) { return cellToMarkdown(tc, ctx); });
    }).filter(function (r) { return r.length; });
    if (!rows.length) return '';

    var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    function pad(r) {
      var out = r.slice();
      while (out.length < width) out.push('');
      return out;
    }
    /* 表头在 Markdown 里由首行隐含表达；去掉 Word 给表头整格加的粗体，
       否则 .md → .docx → .md 往返会凭空多出 ** */
    var head = pad(rows[0]).map(stripCellBold);
    var lines = [
      '| ' + head.join(' | ') + ' |',
      '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'
    ];
    for (var i = 1; i < rows.length; i++) lines.push('| ' + pad(rows[i]).join(' | ') + ' |');
    return lines.join('\n');
  }

  function bodyToMarkdown(body, ctx) {
    var blocks = [];
    var listBuf = [];
    function flushList() {
      if (listBuf.length) { blocks.push(listBuf.join('\n')); listBuf = []; }
    }

    for (var i = 0; i < body.children.length; i++) {
      var c = body.children[i];
      var ln = localName(c.name);
      if (ln === 'p') {
        var info = paragraphInfo(c, ctx, false);
        if (info.list) { listBuf.push(info.list.indent + info.list.marker + ' ' + info.text); continue; }
        flushList();
        if (!info.text.trim()) continue;
        blocks.push(info.level ? new Array(info.level + 1).join('#') + ' ' + info.text : info.text);
      } else if (ln === 'tbl') {
        flushList();
        var t = tableToMarkdown(c, ctx);
        if (t) blocks.push(t);
      }
    }
    flushList();
    return blocks.join('\n\n');
  }

  /* word/numbering.xml → 判断某个 numId+ilvl 是有序还是无序，并给出下一个序号 */
  function parseNumbering(xmlText) {
    var root = parseXml(xmlText);
    var abstractById = {};
    var numToAbstract = {};

    childrenOf(root, 'abstractNum').forEach(function (a) {
      var id = attr(a, 'w:abstractNumId');
      var lvls = {};
      childrenOf(a, 'lvl').forEach(function (l) {
        var il = attr(l, 'w:ilvl');
        var fmtEl = firstChild(l, 'numFmt');
        var startEl = firstChild(l, 'start');
        var start = startEl ? parseInt(attr(startEl, 'w:val'), 10) : 1;
        lvls[il] = {
          fmt: fmtEl ? attr(fmtEl, 'w:val') : 'decimal',
          start: isFinite(start) ? start : 1
        };
      });
      abstractById[id] = lvls;
    });

    childrenOf(root, 'num').forEach(function (n) {
      var nid = attr(n, 'w:numId');
      var a = firstChild(n, 'abstractNumId');
      if (nid && a) numToAbstract[nid] = attr(a, 'w:val');
    });

    var counters = {};
    function levelOf(numId, ilvl) {
      var ab = abstractById[numToAbstract[numId]];
      if (!ab) return null;
      return ab[ilvl] || ab[0] || null;
    }
    return {
      isOrdered: function (numId, ilvl) {
        var lvl = levelOf(numId, ilvl);
        if (!lvl) return false;
        return lvl.fmt !== 'bullet' && lvl.fmt !== 'none';
      },
      nextIndex: function (numId, ilvl) {
        var lvl = levelOf(numId, ilvl);
        var key = numId + ':' + ilvl;
        counters[key] = counters[key] == null ? ((lvl && lvl.start) || 1) : counters[key] + 1;
        return counters[key];
      }
    };
  }

  async function readDocx(input) {
    var files = unzip(input);
    var docXml = await entryText(files, 'word/document.xml');
    if (docXml == null) {
      var alt = Object.keys(files).filter(function (k) { return /(^|\/)document\.xml$/i.test(k); })[0];
      if (alt) docXml = await entryText(files, alt);
    }
    if (docXml == null) throw new Error('不是有效的 .docx：包内缺少 word/document.xml');

    var warnings = [];
    var rels = {};
    var relsXml = await entryText(files, 'word/_rels/document.xml.rels');
    if (relsXml) {
      childrenOf(parseXml(relsXml), 'Relationship').forEach(function (r) {
        var id = attr(r, 'Id');
        var target = attr(r, 'Target');
        if (id && target) rels[id] = target;
      });
    }

    var numbering = null;
    var numXml = await entryText(files, 'word/numbering.xml');
    if (numXml) {
      try { numbering = parseNumbering(numXml); } catch (e) { numbering = null; }
    }

    var body = findDeep(parseXml(docXml), 'body');
    if (!body) throw new Error('document.xml 结构异常：找不到 w:body');

    var ctx = { rels: rels, numbering: numbering, warnings: warnings, images: 0, vertWarned: false };
    var text = bodyToMarkdown(body, ctx);
    if (ctx.images) warnings.push(ctx.images + ' 张图片按包内相对路径保留，可能无法直接显示');
    if (!text.trim()) warnings.push('文档里没有可提取的文本');
    return { text: text.trim() + '\n', warnings: warnings };
  }

  /* ==================================================================
     六、HTML → Markdown（.doc 实为 HTML 时走这里）
     ================================================================== */

  function nodeText(node) {
    var out = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      out += c.name === '#text' ? c.text : nodeText(c);
    }
    return out;
  }

  function htmlInline(node) {
    var out = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      var tag = c.name;
      if (tag === '#text') { out += c.text; continue; }
      var inner = htmlInline(c);
      switch (tag) {
        case 'br': out += '  \n'; break;
        case 'strong': case 'b': out += '**' + inner + '**'; break;
        case 'em': case 'i': out += '*' + inner + '*'; break;
        case 'del': case 's': case 'strike': out += '~~' + inner + '~~'; break;
        case 'code': out += '`' + inner + '`'; break;
        case 'sup': out += inner ? '$^{' + inner + '}$' : ''; break;
        case 'sub': out += inner ? '$_{' + inner + '}$' : ''; break;
        case 'a': {
          var href = attr(c, 'href') || '';
          out += href ? '[' + inner + '](' + href + ')' : inner;
          break;
        }
        case 'img': {
          var src = attr(c, 'src') || '';
          if (src) out += '![' + (attr(c, 'alt') || '') + '](' + src + ')';
          break;
        }
        default: out += inner; break;
      }
    }
    return out;
  }

  var HTML_BLOCK = {
    div: 1, section: 1, article: 1, header: 1, footer: 1, main: 1, body: 1, html: 1,
    form: 1, fieldset: 1, center: 1, figure: 1, figcaption: 1, nav: 1, aside: 1
  };

  function collectRows(node, out) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === 'tr') out.push(c);
      else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot' || c.name === 'table') collectRows(c, out);
    }
  }

  function htmlTable(tbl) {
    var trs = [];
    collectRows(tbl, trs);
    var rows = [];
    for (var i = 0; i < trs.length; i++) {
      var cells = [];
      for (var k = 0; k < trs[i].children.length; k++) {
        var cell = trs[i].children[k];
        if (cell.name !== 'td' && cell.name !== 'th') continue;
        cells.push(htmlInline(cell).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    function pad(r) { var o = r.slice(); while (o.length < width) o.push(''); return o; }
    var head = pad(rows[0]);
    var out = ['| ' + head.join(' | ') + ' |',
               '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
    for (var z = 1; z < rows.length; z++) out.push('| ' + pad(rows[z]).join(' | ') + ' |');
    return out.join('\n');
  }

  /* ul/ol → Markdown 列表；嵌套列表用两空格缩进递归 */
  function htmlList(listNode, blocks, depth) {
    var ordered = listNode.name === 'ol';
    var items = [];
    var subs = [];
    for (var i = 0; i < listNode.children.length; i++) {
      var li = listNode.children[i];
      if (li.name !== 'li') continue;
      var text = '';
      for (var k = 0; k < li.children.length; k++) {
        var ch = li.children[k];
        if (ch.name === 'ul' || ch.name === 'ol') { subs.push(ch); continue; }
        text += ch.name === '#text' ? ch.text : htmlInline(ch);
      }
      text = text.replace(/\s+/g, ' ').trim();
      items.push(indentOf(depth) + (ordered ? (items.length + 1) + '.' : '-') + ' ' + text);
    }
    if (items.length) blocks.push(items.join('\n'));
    for (var s = 0; s < subs.length; s++) htmlList(subs[s], blocks, depth + 1);
  }

  function htmlBlocks(node, blocks, depth) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      var tag = c.name;
      if (tag === '#text') {
        var t = c.text.replace(/\s+/g, ' ').trim();
        if (t) blocks.push(t);
        continue;
      }

      if (/^h[1-6]$/.test(tag)) {
        var ht = htmlInline(c).trim();
        if (ht) blocks.push(new Array(parseInt(tag.charAt(1), 10) + 1).join('#') + ' ' + ht);
        continue;
      }
      if (tag === 'p') {
        var pt = htmlInline(c).trim();
        if (pt) blocks.push(pt);
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        htmlList(c, blocks, depth);
        continue;
      }
      if (tag === 'blockquote') {
        var qb = [];
        htmlBlocks(c, qb, depth);
        var joined = qb.join('\n\n').trim();
        if (joined) blocks.push(joined.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n'));
        continue;
      }
      if (tag === 'pre') {
        blocks.push('```\n' + nodeText(c).replace(/^\n/, '').replace(/\n+$/, '') + '\n```');
        continue;
      }
      if (tag === 'hr') { blocks.push('---'); continue; }
      if (tag === 'table') {
        var tbl = htmlTable(c);
        if (tbl) blocks.push(tbl);
        continue;
      }
      if (HTML_BLOCK[tag] || tag === 'li' || tag === 'td' || tag === 'th' || tag === 'tbody' || tag === 'thead') {
        htmlBlocks(c, blocks, depth);
        continue;
      }
      var inline = htmlInline(c).trim();
      if (inline) blocks.push(inline);
    }
  }

  /* 无 DOM 环境（Node 测试）时的降级：去标签 + 解码实体 + 块级标签换行 */
  function plainFromHtml(src) {
    return decodeEntities(String(src)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 无 DOM 依赖：用自己的宽松解析器（opts.html），
     保证浏览器、Electron 渲染进程与 Node 三处行为完全一致，也便于测试 */
  function htmlToMarkdown(html) {
    var src = String(html == null ? '' : html);
    var warnings = [];
    var root = null;
    try { root = parseXml(src, { html: true }); } catch (e) { root = null; }
    if (!root) {
      warnings.push('HTML 结构无法解析，已按纯文本提取');
      return { text: plainFromHtml(src) + '\n', warnings: warnings };
    }
    var body = findDeep(root, 'body') || root;
    var blocks = [];
    htmlBlocks(body, blocks, 0);
    var text = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) warnings.push('HTML 里没有可提取的正文');
    return { text: text + '\n', warnings: warnings };
  }

  /* ==================================================================
     七、类型识别与拖入入口
     ================================================================== */

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /* 内容嗅探：扩展名不可靠时（.txt / 无扩展名）用特征判断 */
  function looksLikeLatex(text) {
    return /\\documentclass\b/.test(text)
      || /\\begin\s*\{(document|itemize|enumerate|tabular|equation|align|figure|table|abstract)\}/.test(text)
      || /\\(?:section|subsection|textbf|emph|includegraphics)\s*\{/.test(text);
  }

  function sniffKind(name, text) {
    var ext = extOf(name);
    if (ext === 'docx') return 'docx';
    if (ext === 'doc') return 'doc';
    if (ext === 'tex' || ext === 'latex') return 'latex';
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    /* .txt 与无扩展名：靠内容特征区分 Markdown 与 LaTeX */
    return looksLikeLatex(String(text || '')) ? 'latex' : 'markdown';
  }

  /* 类型互补推荐：拖进来的东西决定了导出的默认格式 ——
     Markdown/Word 输入（内容最终都是 Markdown）→ 推荐导出 LaTeX；
     LaTeX 输入 → 推荐导出 Word（.docx）。 */
  function recommendFormat(kind) {
    return kind === 'latex' ? 'docx' : 'tex';
  }

  /* 统一的「拖入文件 → Markdown」入口。
     返回 { kind, source, text, warnings }；kind 决定后续的导出推荐与转换方向。 */
  async function readDropped(name, bytes) {
    var b = u8(bytes);
    if (!b.length) throw new Error('文件是空的');

    var ext = extOf(name);
    if (ext === 'docx' || isZip(b)) {
      var docx = await readDocx(b);
      return { kind: 'markdown', source: 'docx', text: docx.text, warnings: docx.warnings };
    }
    if (ext === 'doc' || isOle(b)) {
      if (isOle(b)) {
        throw new Error('这是旧版二进制 .doc（OLE 复合文档），暂不支持直接解析；请在 Word 里「另存为」成 .docx 后再拖进来。');
      }
      var conv = htmlToMarkdown(decodeText(b));
      return { kind: 'markdown', source: 'doc', text: conv.text, warnings: conv.warnings };
    }

    var text = decodeText(b);
    if (!text.trim()) throw new Error('文件里没有可读文本');
    var kind = sniffKind(name, text);
    return { kind: kind, source: kind, text: text, warnings: [] };
  }

  return {
    /* 拖入入口 */
    readDropped: readDropped,
    sniffKind: sniffKind,
    recommendFormat: recommendFormat,
    looksLikeLatex: looksLikeLatex,
    /* 单项能力，便于单独复用与测试 */
    readDocx: readDocx,
    unzip: unzip,
    parseXml: parseXml,
    ommlToLatex: ommlToLatex,
    htmlToMarkdown: htmlToMarkdown,
    isZip: isZip,
    isOle: isOle,
    decodeText: decodeText
  };
});