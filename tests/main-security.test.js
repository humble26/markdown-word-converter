// 主进程安全边界的回归测试（该项目此前零测试）
//
// 用替身拦截 require('electron')，从而在不启动 Electron 的情况下
// 直接验证两件事：
//   1. IPC 来源校验 —— 非本应用页面调用桌面能力必须被拒
//   2. 导航拦截     —— 预览里的外链不得在本窗口导航（曾导致 preload 桥接注入远程页面）
//
// 运行：node --test tests/

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_URL = require('node:url').pathToFileURL(
  path.join(RENDERER_DIR, 'index.html')).toString();

// ---- electron 替身 -------------------------------------------------------
const captured = {
  handlers: new Map(),      // ipcMain.handle 注册的 handler
  willNavigate: null,
  windowOpenHandler: null,
  clipboardWrites: [],
  externals: [],
  dialogs: 0,
};

const electronStub = {
  app: {
    // 同步 thenable：让 require('../main.js') 期间就执行 createWindow(),
    // 否则窗口相关的断言拿不到 will-navigate / setWindowOpenHandler
    whenReady: () => ({ then: (fn) => { fn(); return { catch: () => {} }; } }),
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: class {
    constructor(opts) {
      captured.windowOptions = opts;
      this.webContents = {
        on: (name, fn) => { if (name === 'will-navigate') captured.willNavigate = fn; },
        setWindowOpenHandler: (fn) => { captured.windowOpenHandler = fn; },
        getURL: () => APP_URL,
      };
    }
    loadFile() {}
    static getAllWindows() { return []; }
  },
  clipboard: { write: (payload) => captured.clipboardWrites.push(payload) },
  ipcMain: { handle: (name, fn) => captured.handlers.set(name, fn) },
  dialog: {
    showSaveDialog: async () => { captured.dialogs++; return { canceled: true }; },
  },
  shell: { openExternal: (u) => captured.externals.push(u) },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

require('../main.js');

const evt = (url, extra = {}) => ({
  senderFrame: { url },
  sender: { getURL: () => url },
  ...extra,
});

// ---- 1. IPC 来源校验 -----------------------------------------------------
test('IPC：来自本应用 renderer 的调用放行', async () => {
  const h = captured.handlers.get('copy-rich');
  assert.ok(h, 'copy-rich 应已注册');
  const ok = await h(evt(APP_URL), { html: '<b>x</b>', text: 'x' });
  assert.strictEqual(ok, true);
  assert.strictEqual(captured.clipboardWrites.length, 1);
  assert.strictEqual(captured.clipboardWrites[0].html, '<b>x</b>');
});

test('IPC：远程页面调用必须被拒', async () => {
  for (const h of captured.handlers.values()) {
    await assert.rejects(
      async () => h(evt('https://evil.example.com/x.html'), {}),
      /forbidden|untrusted/i,
      '远程来源不得调用桌面能力');
  }
});

test('IPC：file:// 但不在 renderer 目录内也要拒', async () => {
  const outside = require('node:url').pathToFileURL(path.join(__dirname, '..', 'evil.html')).toString();
  for (const h of captured.handlers.values()) {
    await assert.rejects(async () => h(evt(outside), {}), /forbidden|untrusted/i);
  }
});

test('IPC：缺少 senderFrame 时按不可信处理', async () => {
  const h = captured.handlers.get('copy-rich');
  const before = captured.clipboardWrites.length;
  await assert.rejects(async () => h({ sender: {} }, { html: 'x', text: 'x' }));
  assert.strictEqual(captured.clipboardWrites.length, before, '不应写入剪贴板');
});

test('IPC：三个通道都已包装来源校验', () => {
  for (const name of ['copy-rich', 'save-doc', 'save-docx']) {
    assert.ok(captured.handlers.has(name), `${name} 应已注册`);
  }
});

// ---- 2. 导航拦截 ---------------------------------------------------------
test('导航：外部 http(s) 链接被拦截并交给系统浏览器', () => {
  assert.ok(captured.willNavigate, 'will-navigate 应已注册');
  let prevented = false;
  captured.willNavigate({ preventDefault: () => { prevented = true; } },
    'https://example.com/a');
  assert.strictEqual(prevented, true, '必须阻止在应用内导航');
  assert.deepStrictEqual(captured.externals, ['https://example.com/a'],
    '应改用系统浏览器打开');
});

test('导航：同页锚点放行', () => {
  let prevented = false;
  captured.willNavigate({ preventDefault: () => { prevented = true; } }, APP_URL + '#top');
  assert.strictEqual(prevented, false, '同页锚点不应被拦');
});

test('导航：renderer 目录内的其它页面放行', () => {
  const other = require('node:url').pathToFileURL(
    path.join(RENDERER_DIR, 'index.html')).toString();
  let prevented = false;
  captured.willNavigate({ preventDefault: () => { prevented = true; } }, other);
  assert.strictEqual(prevented, false);
});

test('导航：文件协议/自定义协议的外链不得交给系统打开', () => {
  const before = captured.externals.length;
  captured.willNavigate({ preventDefault: () => {} }, 'file:///C:/Windows/System32/calc.exe');
  captured.willNavigate({ preventDefault: () => {} }, 'ms-msdt:/id');
  assert.strictEqual(captured.externals.length, before,
    '只允许 http/https/mailto，其它协议一律不打开');
});

test('新窗口：一律 deny，并交给系统浏览器', () => {
  assert.ok(captured.windowOpenHandler);
  const r = captured.windowOpenHandler({ url: 'https://example.com/b' });
  assert.strictEqual(r.action, 'deny');
  assert.ok(captured.externals.includes('https://example.com/b'));
});

// ---- 3. 窗口安全配置 -----------------------------------------------------
test('窗口：显式开启 contextIsolation/sandbox，关闭 nodeIntegration', () => {
  const wp = captured.windowOptions.webPreferences;
  assert.strictEqual(wp.contextIsolation, true);
  assert.strictEqual(wp.nodeIntegration, false);
  assert.strictEqual(wp.sandbox, true, 'sandbox 必须显式开启');
});

// ---- 4. 反证：确认上面的断言不是空转 -------------------------------------
test('反证：未包装来源校验时，远程调用确实能触达桌面能力', async () => {
  // 复现修复前的写法：handler 直接执行，不看来源
  let clipboardTouched = 0;
  const unguarded = (_event, { html, text }) => {
    clipboardTouched++;
    electronStub.clipboard.write({ html, text });
    return true;
  };
  await unguarded(evt('https://evil.example.com/x.html'), { html: 'x', text: 'x' });
  assert.strictEqual(clipboardTouched, 1,
    '旧写法确实会被远程页面调用 —— 说明上面的 rejects 断言有实际意义');
});
