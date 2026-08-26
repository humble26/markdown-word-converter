# Markdown → Word 转换器

将 AI 回复的 Markdown 内容一键转换为带格式的富文本，粘贴到 Word 后标题、加粗、列表、表格、代码块等样式完整保留。支持直接导出 .doc Word 文档文件。

## 功能

- **复制富文本**：一键复制带格式内容，粘贴到 Word 样式完整保留
- **导出 Word 文档**：直接生成 .doc 文件保存到本地，无需手动复制粘贴
- **实时预览**：左侧输入 Markdown，右侧即时显示转换效果
- **离线解析**：内置轻量 Markdown 解析器，无需联网

## 版本

| 版本 | 路径 | 说明 |
|------|------|------|
| 桌面版（Electron） | `main.js` + `renderer/` | 可打包为 Windows 安装程序，使用原生剪贴板 API，导出时弹出系统保存对话框 |
| 网页版 | `web/markdown-word-converter.html` | 单文件 HTML，双击即用，无需安装，导出时浏览器直接下载 |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式运行
npm start

# 打包为 Windows 安装程序（需管理员权限）
npx electron-builder --win
```

详见 [安装指南](./INSTALLATION-GUIDE.html)。

## 更新日志

### v1.1.0
- 新增「导出 Word 文档」功能，直接生成 .doc 文件
- 桌面版使用系统保存对话框，网页版浏览器直接下载
- 文件名自动从首个标题提取

### v1.0.0
- 初始版本
- Markdown 解析、富文本复制、实时预览
