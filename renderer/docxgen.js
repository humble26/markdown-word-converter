/* docxgen.js — 把转换后的 HTML 片段打包成真正的 .docx（OOXML）文件
   零第三方依赖、纯前端实现，离线可用；浏览器与 Node 均可运行。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.docxgen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var CONTENT_WIDTH = 9026; // A4 去掉左右页边距后的可用宽度（twips）

  /* XML 1.0 只允许 #x9/#xA/#xD 与 #x20 以上字符；其余控制字符、孤立代理对
     必须剔除，否则 Word 会判定文档损坏。 */
  function xmlSafe(s) {
    s = String(s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13) { out += s.charAt(i); continue; }
      if (c < 0x20 || c === 0xFFFE || c === 0xFFFF) continue;
      if (c >= 0xD800 && c <= 0xDBFF) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { out += s.charAt(i) + s.charAt(i + 1); i++; }
        continue;
      }
      if (c >= 0xDC00 && c <= 0xDFFF) continue;
      out += s.charAt(i);
    }
    return out;
  }

  function esc(s) {
    return xmlSafe(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function decodeEnt(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, '\u00a0')
      .replace(/&amp;/g, '&');
  }

  /* ---------------- 极简 HTML 解析（只处理本工具自己生成的标签） ---------------- */
  var VOID_TAGS = { hr: 1, br: 1, img: 1, meta: 1, link: 1, input: 1 };

  function parseHtml(html) {
    var root = { type: 'el', tag: '#root', attrs: {}, children: [] };
    var stack = [root];
    var i = 0;

    function pushText(raw) {
      if (!raw) return;
      stack[stack.length - 1].children.push({ type: 'text', text: decodeEnt(raw) });
    }

    while (i < html.length) {
      var lt = html.indexOf('<', i);
      if (lt < 0) { pushText(html.slice(i)); break; }
      if (lt > i) pushText(html.slice(i, lt));
      var gt = html.indexOf('>', lt);
      if (gt < 0) { pushText(html.slice(lt)); break; }
      var raw = html.slice(lt + 1, gt);

      if (raw.charAt(0) === '/') {
        var closeName = raw.slice(1).trim().toLowerCase();
        for (var k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag === closeName) { stack.length = k; break; }
        }
        i = gt + 1;
        continue;
      }
      if (raw.charAt(0) === '!' || raw.charAt(0) === '?') { i = gt + 1; continue; }

      var selfClose = /\/\s*$/.test(raw);
      var body = selfClose ? raw.replace(/\/\s*$/, '') : raw;
      var nameMatch = body.match(/^([a-zA-Z][\w-]*)/);
      if (!nameMatch) { i = gt + 1; continue; }

      var tag = nameMatch[1].toLowerCase();
      var attrs = {};
      var attrRe = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      var am;
      while ((am = attrRe.exec(body))) {
        attrs[am[1].toLowerCase()] = decodeEnt(am[2] != null ? am[2] : (am[3] != null ? am[3] : am[4]));
      }
      var node = { type: 'el', tag: tag, attrs: attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose && !VOID_TAGS[tag]) stack.push(node);
      i = gt + 1;
    }
    return root.children;
  }

  /* ---------------- 行内内容 → w:r ---------------- */
  function runXml(text, fmt) {
    var rPr = [];
    if (fmt.code) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
    if (fmt.b) rPr.push('<w:b/><w:bCs/>');
    if (fmt.i) rPr.push('<w:i/><w:iCs/>');
    if (fmt.strike) rPr.push('<w:strike/>');
    if (fmt.href) rPr.push('<w:color w:val="2F6FED"/><w:u w:val="single"/>');
    if (fmt.code) rPr.push('<w:shd w:val="clear" w:color="auto" w:fill="F1F3F7"/>');
    if (fmt.sz) rPr.push('<w:sz w:val="' + fmt.sz + '"/><w:szCs w:val="' + fmt.sz + '"/>');
    var rpr = rPr.length ? '<w:rPr>' + rPr.join('') + '</w:rPr>' : '';

    var parts = String(text).split('\n');
    var inner = '';
    for (var i = 0; i < parts.length; i++) {
      if (i) inner += '<w:br/>';
      inner += '<w:t xml:space="preserve">' + esc(parts[i]) + '</w:t>';
    }
    return '<w:r>' + rpr + inner + '</w:r>';
  }

  /* ---------------- 公式节点（OMML 由调用方注入转换器产出） ----------------
     docxgen 保持零依赖：它不 import texconv，而是由调用方通过
     build(html, { mathToOmml }) 注入一个 (tex, isBlock) => xml 的函数。
     转换失败时退回显示 LaTeX 原文，绝不让整篇导出失败。 */
  function mathClassMatch(node, name) {
    if (!node || node.type !== 'el') return false;
    return (' ' + (node.attrs.class || '') + ' ').indexOf(' ' + name + ' ') >= 0;
  }

  function mathNodeXml(node, ctx, block) {
    if (!ctx.mathToOmml) return null;
    var tex = node.attrs['data-tex'];
    if (tex == null) return null;
    try {
      return ctx.mathToOmml(tex, !!block) || null;
    } catch (e) {
      return null;
    }
  }

  function runsFromNodes(nodes, fmt, ctx) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'text') { out += runXml(n.text, fmt); continue; }
      if (mathClassMatch(n, 'math-inline')) {
        var mx = mathNodeXml(n, ctx, false);
        out += mx || runXml('$' + (n.attrs['data-tex'] || '') + '$', fmt);
        continue;
      }
      if (mathClassMatch(n, 'math-block')) {
        var mxb = mathNodeXml(n, ctx, true);
        out += mxb || runXml('$$' + (n.attrs['data-tex'] || '') + '$$', fmt);
        continue;
      }
      if (n.tag === 'br') { out += runXml('\n', fmt); continue; }
      if (n.tag === 'strong' || n.tag === 'b') { out += runsFromNodes(n.children, mix(fmt, { b: true }), ctx); continue; }
      if (n.tag === 'em' || n.tag === 'i') { out += runsFromNodes(n.children, mix(fmt, { i: true }), ctx); continue; }
      if (n.tag === 'del' || n.tag === 's' || n.tag === 'strike') { out += runsFromNodes(n.children, mix(fmt, { strike: true }), ctx); continue; }
      if (n.tag === 'code') { out += runsFromNodes(n.children, mix(fmt, { code: true }), ctx); continue; }
      if (n.tag === 'a') {
        var href = n.attrs.href || '';
        if (href && !/^[a-z][\w+.-]*:/i.test(href)) href = 'http://' + href;
        // 空链接或文档内锚点无法生成有效关系，退化为纯文本，避免产生悬空的 rId
        if (!href || href.charAt(0) === '#') { out += runsFromNodes(n.children, fmt, ctx); continue; }
        var id = ctx.addLink(href);
        out += '<w:hyperlink r:id="rId' + id + '" w:history="1">'
          + runsFromNodes(n.children, mix(fmt, { href: true }), ctx) + '</w:hyperlink>';
        continue;
      }
      if (n.tag === 'img') {
        var alt = n.attrs.alt || '图片';
        var src = n.attrs.src || '';
        out += runXml('[图片] ' + alt + (src ? '（' + src + '）' : ''), fmt);
        continue;
      }
      out += runsFromNodes(n.children, fmt, ctx);
    }
    return out;
  }

  function mix(fmt, patch) {
    var o = {};
    for (var k in fmt) if (Object.prototype.hasOwnProperty.call(fmt, k)) o[k] = fmt[k];
    for (var p in patch) if (Object.prototype.hasOwnProperty.call(patch, p)) o[p] = patch[p];
    return o;
  }

  /* ---------------- 块级内容 → w:p / w:tbl ---------------- */
  var BORDER = '<w:tblBorders>'
    + '<w:top w:val="single" w:sz="4" w:space="0" w:color="D3D8E0"/>'
    + '<w:left w:val="single" w:sz="4" w:space="0" w:color="D3D8E0"/>'
    + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D3D8E0"/>'
    + '<w:right w:val="single" w:sz="4" w:space="0" w:color="D3D8E0"/>'
    + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D3D8E0"/>'
    + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D3D8E0"/>'
    + '</w:tblBorders>';

  function para(runs, pPrExtra) {
    var pPr = pPrExtra ? '<w:pPr>' + pPrExtra + '</w:pPr>' : '';
    return '<w:p>' + pPr + runs + '</w:p>';
  }

  function preXml(node, ctx) {
    var text = collectText(node);
    var lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    var pPr = '<w:shd w:val="clear" w:color="auto" w:fill="F5F7FA"/>'
      + '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>'
      + '<w:ind w:left="120" w:right="120"/>';
    var out = '';
    for (var i = 0; i < lines.length; i++) {
      out += para(runXml(lines[i] || '', { code: true }), pPr);
    }
    return out || para('', pPr);
  }

  function quoteXml(node, ctx) {
    var pPr = '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="2F6FED"/></w:pBdr>'
      + '<w:shd w:val="clear" w:color="auto" w:fill="F4F7FF"/>'
      + '<w:ind w:left="240" w:right="120"/>';
    var out = '';
    var children = node.children;
    var buffer = [];

    function flush() {
      if (!buffer.length) return;
      out += para(runsFromNodes(buffer, {}, ctx), pPr);
      buffer = [];
    }

    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')) {
        flush();
        out += listXml(c, ctx.newList(c.tag === 'ol'), 0, ctx, c.tag === 'ol');
      } else if (c.type === 'el' && c.tag === 'table') {
        flush();
        out += tableXml(c, ctx);
      } else if (c.type === 'el' && (c.tag === 'p' || c.tag === 'div')) {
        flush();
        out += para(runsFromNodes(c.children, {}, ctx), pPr);
      } else {
        buffer.push(c);
      }
    }
    flush();
    return out;
  }

  function listXml(node, numId, level, ctx, ordered) {
    var ilvl = Math.min(level, 8);
    var out = '';
    for (var i = 0; i < node.children.length; i++) {
      var li = node.children[i];
      if (li.type !== 'el' || li.tag !== 'li') continue;
      var inline = [];
      var nested = [];
      for (var j = 0; j < li.children.length; j++) {
        var c = li.children[j];
        if (c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')) nested.push(c);
        else inline.push(c);
      }
      out += para(runsFromNodes(inline, {}, ctx),
        '<w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr>');
      for (var k = 0; k < nested.length; k++) {
        var nl = nested[k];
        var nlOrdered = nl.tag === 'ol';
        // 同类型子列表沿用父列表编号（形成多级编号）；异类型另起一个新列表
        if (nlOrdered === ordered) out += listXml(nl, numId, level + 1, ctx, ordered);
        else out += listXml(nl, ctx.newList(nlOrdered), level + 1, ctx, nlOrdered);
      }
    }
    return out;
  }

  function tableXml(node, ctx) {
    var rows = [];
    (function collect(list) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n.type !== 'el') continue;
        if (n.tag === 'tr') rows.push(n);
        else if (n.tag === 'thead' || n.tag === 'tbody' || n.tag === 'tfoot') collect(n.children);
      }
    })(node.children);

    var colCount = 0;
    var parsed = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = [];
      for (var c = 0; c < rows[r].children.length; c++) {
        var cell = rows[r].children[c];
        if (cell.type === 'el' && (cell.tag === 'td' || cell.tag === 'th')) cells.push(cell);
      }
      if (cells.length > colCount) colCount = cells.length;
      parsed.push(cells);
    }
    if (!colCount) return '';

    var gridW = Math.floor(CONTENT_WIDTH / colCount);
    var grid = '';
    for (var g = 0; g < colCount; g++) grid += '<w:gridCol w:w="' + gridW + '"/>';

    var body = '';
    for (var i = 0; i < parsed.length; i++) {
      var cells = parsed[i];
      var isHead = false;
      for (var h = 0; h < cells.length; h++) if (cells[h].tag === 'th') isHead = true;
      var trPr = isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      var tr = '<w:tr>' + trPr;
      // 按列数补齐空单元格，避免行单元格数与 tblGrid 不一致导致排版错乱
      for (var j = 0; j < colCount; j++) {
        var cellNode = cells[j];
        if (!cellNode) {
          tr += '<w:tc><w:tcPr><w:tcW w:w="' + gridW + '" w:type="dxa"/></w:tcPr>' + para('') + '</w:tc>';
          continue;
        }
        var head = cellNode.tag === 'th';
        var tcPr = '<w:tcW w:w="' + gridW + '" w:type="dxa"/>'
          + (head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>' : '');
        tr += '<w:tc><w:tcPr>' + tcPr + '</w:tcPr>'
          + para(runsFromNodes(cellNode.children, head ? { b: true } : {}, ctx),
            '<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>')
          + '</w:tc>';
      }
      tr += '</w:tr>';
      body += tr;
    }

    return '<w:tbl><w:tblPr><w:tblW w:w="' + CONTENT_WIDTH + '" w:type="dxa"/>' + BORDER
      + '</w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>' + body + '</w:tbl>' + para('');
  }

  function collectText(node) {
    var s = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      s += c.type === 'text' ? c.text : collectText(c);
    }
    return s;
  }

  function blocks(nodes, ctx) {
    var out = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'text') {
        if (n.text.trim()) out += para(runXml(n.text.replace(/\s+/g, ' ').trim(), {}));
        continue;
      }
      var tag = n.tag;
      /* 块级公式：m:oMathPara 必须包在 w:p 里，且独占该段落 */
      if (mathClassMatch(n, 'math-block')) {
        var mb = mathNodeXml(n, ctx, true);
        out += para(mb || runXml('$$' + (n.attrs['data-tex'] || '') + '$$', {}));
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        var lvl = parseInt(tag.charAt(1), 10);
        out += para(runsFromNodes(n.children, {}, ctx), '<w:pStyle w:val="Heading' + lvl + '"/>');
      } else if (tag === 'p') {
        out += para(runsFromNodes(n.children, {}, ctx));
      } else if (tag === 'hr') {
        out += para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>');
      } else if (tag === 'blockquote') {
        out += quoteXml(n, ctx);
      } else if (tag === 'pre') {
        out += preXml(n, ctx);
      } else if (tag === 'ul' || tag === 'ol') {
        out += listXml(n, ctx.newList(tag === 'ol'), 0, ctx, tag === 'ol');
      } else if (tag === 'table') {
        out += tableXml(n, ctx);
      } else if (tag === 'div' || tag === 'section' || tag === 'body') {
        out += blocks(n.children, ctx);
      } else {
        out += para(runsFromNodes([n], {}, ctx));
      }
    }
    return out;
  }

  /* ---------------- OOXML 固定部件 ---------------- */
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  var CONTENT_TYPES = XML_HEAD
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '</Types>';

  var ROOT_RELS = XML_HEAD
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  var HEADING_STYLES = (function () {
    var sizes = [32, 28, 24, 22, 22, 22];
    var before = [280, 240, 200, 180, 160, 160];
    var out = '';
    for (var i = 0; i < 6; i++) {
      out += '<w:style w:type="paragraph" w:styleId="Heading' + (i + 1) + '">'
        + '<w:name w:val="heading ' + (i + 1) + '"/>'
        + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        + '<w:pPr><w:keepNext/><w:keepLines/>'
        + '<w:spacing w:before="' + before[i] + '" w:after="120"/>'
        + '<w:outlineLvl w:val="' + i + '"/></w:pPr>'
        + '<w:rPr><w:b/><w:sz w:val="' + sizes[i] + '"/><w:szCs w:val="' + sizes[i] + '"/>'
        + '<w:color w:val="1F2430"/></w:rPr></w:style>';
    }
    return out;
  })();

  var STYLES = XML_HEAD
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults>'
    + '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑" w:cs="Calibri"/>'
    + '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + HEADING_STYLES
    + '</w:styles>';

  /* 0 = 无序（项目符号），1 = 有序（阿拉伯数字）；每个列表单独分配 numId，
     使多个列表各自从 1 开始编号，而不是跨段落连续编号。 */
  function abstractNumsXml() {
    var bullet = '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>';
    var decimal = '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>';
    for (var i = 0; i < 9; i++) {
      var ind = 420 + i * 420;
      bullet += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="bullet"/>'
        + '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/>'
        + '<w:pPr><w:ind w:left="' + ind + '" w:hanging="420"/></w:pPr></w:lvl>';
      decimal += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="decimal"/>'
        + '<w:lvlText w:val="%' + (i + 1) + '."/><w:lvlJc w:val="left"/>'
        + '<w:pPr><w:ind w:left="' + ind + '" w:hanging="420"/></w:pPr></w:lvl>';
    }
    return bullet + '</w:abstractNum>' + decimal + '</w:abstractNum>';
  }

  function numberingXml(nums) {
    var out = XML_HEAD
      + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + abstractNumsXml();
    for (var i = 0; i < nums.length; i++) {
      out += '<w:num w:numId="' + nums[i].numId + '">'
        + '<w:abstractNumId w:val="' + nums[i].abstractId + '"/>'
        + '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>';
    }
    return out + '</w:numbering>';
  }

  var SECT_PR = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>'
    + '</w:sectPr>';

  /* ---------------- ZIP（仅存储，不压缩） ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function zip(files) {
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    var parts = [];
    var central = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var nameBytes = utf8(files[i].name);
      var data = files[i].data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);
      central.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: offset });
      offset += local.length + data.length;
    }

    var cdParts = [];
    var cdSize = 0;
    for (var j = 0; j < central.length; j++) {
      var e = central[j];
      var cd = new Uint8Array(46 + e.nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, e.crc, true);
      cv.setUint32(20, e.size, true);
      cv.setUint32(24, e.size, true);
      cv.setUint16(28, e.nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, e.offset, true);
      cd.set(e.nameBytes, 46);
      cdParts.push(cd);
      cdSize += cd.length;
    }

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var all = parts.concat(cdParts, [eocd]);
    var total = 0;
    for (var m = 0; m < all.length; m++) total += all[m].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var q = 0; q < all.length; q++) { out.set(all[q], pos); pos += all[q].length; }
    return out;
  }

  /* ---------------- 组装 .docx ---------------- */
  function build(html, opts) {
    opts = opts || {};
    var nodes = parseHtml(String(html || ''));
    var links = [];
    var ctx = {
      nums: [],
      nextNumId: 1,
      /* 公式转换器由调用方注入，docxgen 自身不依赖 texconv */
      mathToOmml: typeof opts.mathToOmml === 'function' ? opts.mathToOmml : null,
      newList: function (ordered) {
        var id = this.nextNumId++;
        this.nums.push({ numId: id, abstractId: ordered ? 1 : 0 });
        return id;
      },
      addLink: function (href) {
        var found = -1;
        for (var i = 0; i < links.length; i++) if (links[i] === href) { found = i; break; }
        if (found < 0) { links.push(href); found = links.length - 1; }
        return 100 + found;
      }
    };

    var body = blocks(nodes, ctx);

    var docRels = XML_HEAD
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
    for (var i = 0; i < links.length; i++) {
      docRels += '<Relationship Id="rId' + (100 + i) + '" '
        + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
        + 'Target="' + esc(links[i]) + '" TargetMode="External"/>';
    }
    docRels += '</Relationships>';

    var document = XML_HEAD
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      /* 数学命名空间：没有公式时声明也无害，有公式时缺了它 Word 直接判文档损坏 */
      + 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
      + '<w:body>' + (body || para('')) + SECT_PR + '</w:body></w:document>';

    return zip([
      { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
      { name: '_rels/.rels', data: utf8(ROOT_RELS) },
      { name: 'word/document.xml', data: utf8(document) },
      { name: 'word/_rels/document.xml.rels', data: utf8(docRels) },
      { name: 'word/styles.xml', data: utf8(STYLES) },
      { name: 'word/numbering.xml', data: utf8(numberingXml(ctx.nums)) }
    ]);
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(bytes).toString('base64');
    var s = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  return { build: build, toBase64: toBase64, mime: MIME };
});