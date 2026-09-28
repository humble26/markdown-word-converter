const { app, BrowserWindow, clipboard, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER_DIR = path.join(__dirname, 'renderer');

// 清洗为合法 Windows 文件名，防止含 : * ? 等字符导致保存失败
function sanitizeFilename(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/g, '');
  return clean || '导出文档';
}

/**
 * 判断一个 URL 是否属于本应用自己的渲染页面。
 *
 * 安全边界：协议必须是 file:，且解析后的路径必须落在 renderer/ 目录内。
 * 不依赖对象同一性判断（Electron 在打包环境下并不保证 senderFrame 是同一实例，
 * 桌面工作台 v1.8.2 就是因为用 `senderFrame !== sender.mainFrame` 判断
 * 顶层框架，结果打包后把**所有** IPC 都拒掉了，界面直接白屏）。
 */
function isAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    let p = decodeURIComponent(u.pathname);
    // Windows 下 file:///E:/x 的 pathname 是 /E:/x，去掉前导斜杠再比较
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    const rel = path.relative(RENDERER_DIR, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** IPC 来源校验：只接受来自本应用 renderer 页面的调用。 */
function isTrustedSender(event) {
  const frame = event.senderFrame;
  const url = (frame && frame.url) ||
    (event.sender && typeof event.sender.getURL === 'function' && event.sender.getURL()) ||
    '';
  return isAppUrl(url);
}

/** 包装 handler：来源不可信直接拒绝，避免远程页面调用桌面能力。 */
function guard(handler) {
  return (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn('[安全] 拒绝来自非本应用页面的 IPC 调用:', event.senderFrame && event.senderFrame.url);
      throw new Error('forbidden: untrusted sender');
    }
    return handler(event, ...args);
  };
}

/** 只把 http/https/mailto 交给系统浏览器，其余协议一律不打开。 */
function openExternalSafely(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
    shell.openExternal(url);
  } else {
    console.warn('[安全] 拒绝打开非 http/https/mailto 链接:', url);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 780,
    minHeight: 540,
    title: 'Markdown → Word 转换器',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20+ 的默认值就是 true，这里显式写出来，避免以后有人改动默认值时失去这层保护
      sandbox: true
    }
  });

  // 预览里的链接以前会在**同一窗口**导航过去，而 preload 会在导航后的远程页面继续注入，
  // 等于把 desktopAPI（剪贴板 / 保存文件）暴露给任意网页。
  // 现在：一律拦截导航，改用系统浏览器打开。
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;              // 同页锚点等，放行
    event.preventDefault();
    openExternalSafely(url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };              // 不在应用内开新窗口
  });

  win.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

// 通过 Electron 原生剪贴板写入富文本，Word 粘贴时格式还原最可靠
ipcMain.handle('copy-rich', guard((_event, payload) => {
  const { html, text } = payload || {};
  clipboard.write({ html: String(html || ''), text: String(text || '') });
  return true;
}));

// 导出 Word 文档：弹出保存对话框，将富文本 HTML 写入 .doc 文件
ipcMain.handle('save-doc', guard(async (_event, payload) => {
  const { filename, html } = payload || {};
  const result = await dialog.showSaveDialog({
    title: '保存 Word 文档',
    defaultPath: sanitizeFilename(filename),
    filters: [{ name: 'Word 文档', extensions: ['doc'] }],
    properties: ['createDirectory']
  });
  if (result.canceled || !result.filePath) return { saved: false };
  // 写带 BOM 的 UTF-8，Word 打开 .doc（实为 HTML）时中文可正确识别
  fs.writeFileSync(result.filePath, '\ufeff' + String(html || ''), 'utf-8');
  return { saved: true, path: result.filePath };
}));

// 导出原生 .docx（OOXML）：接收 base64 二进制内容写入文件
ipcMain.handle('save-docx', guard(async (_event, payload) => {
  const { filename, base64 } = payload || {};
  const result = await dialog.showSaveDialog({
    title: '保存 Word 文档',
    defaultPath: sanitizeFilename(filename) + '.docx',
    filters: [{ name: 'Word 文档 (*.docx)', extensions: ['docx'] }],
    properties: ['createDirectory']
  });
  if (result.canceled || !result.filePath) return { saved: false };
  // 校验 base64 而非静默写入损坏文件（原来 Buffer.from 对非法输入不报错，会写出坏包）
  const b64 = String(base64 || '');
  const buf = Buffer.from(b64, 'base64');
  if (!b64 || buf.length === 0) {
    return { saved: false, error: '导出内容为空' };
  }
  fs.writeFileSync(result.filePath, buf);
  return { saved: true, path: result.filePath };
}));

// 通用文本导出（LaTeX 源码等）：带 BOM 交给系统按 UTF-8 识别更稳
ipcMain.handle('save-text', guard(async (_event, payload) => {
  const { filename, content } = payload || {};
  const result = await dialog.showSaveDialog({
    title: '保存文件',
    defaultPath: sanitizeFilename(String(filename || '导出')),
    properties: ['createDirectory']
  });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, String(content || ''), 'utf-8');
  return { saved: true, path: result.filePath };
}));

// 打开 LaTeX 源文件（「导入 .tex」按钮用；拖拽走渲染进程 File API，不经这里）
ipcMain.handle('open-tex', guard(async () => {
  const result = await dialog.showOpenDialog({
    title: '打开 LaTeX 源文件',
    filters: [
      { name: 'LaTeX 源文件', extensions: ['tex', 'latex'] },
      { name: '文本文件', extensions: ['txt', 'md'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { opened: false };
  // .tex 可能是各种编码产生的，先按 UTF-8 读，出现替换符再退回 GBK 兜底
  const p = result.filePaths[0];
  let text = fs.readFileSync(p, 'utf-8');
  if (text.indexOf('\uFFFD') >= 0) {
    try { text = fs.readFileSync(p, 'gbk'); } catch (e) { /* 保持 UTF-8 结果 */ }
  }
  return { opened: true, path: p, text: text };
}));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});