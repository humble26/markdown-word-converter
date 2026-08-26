const { app, BrowserWindow, clipboard, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

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
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// 通过 Electron 原生剪贴板写入富文本，Word 粘贴时格式还原最可靠
ipcMain.handle('copy-rich', (_event, { html, text }) => {
  clipboard.write({ html, text });
  return true;
});

// 导出 Word 文档：弹出保存对话框，将富文本 HTML 写入 .doc 文件
ipcMain.handle('save-doc', async (_event, { filename, html }) => {
  const result = await dialog.showSaveDialog({
    title: '保存 Word 文档',
    defaultPath: filename || '导出文档',
    filters: [{ name: 'Word 文档', extensions: ['doc'] }],
    properties: ['createDirectory']
  });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, html, 'utf-8');
  return { saved: true, path: result.filePath };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});