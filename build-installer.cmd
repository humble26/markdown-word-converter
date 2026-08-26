@echo off
chcp 65001 >nul
title 生成 Markdown-Word 转换器安装包
echo.
echo  正在生成安装包，请勿关闭本窗口...
echo.

cd /d "%~dp0"

set "ELECTRON_BUILDER_CACHE=%~dp0electron-builder-cache"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

call npx electron-builder --win

echo.
if exist "%ELECTRON_BUILDER_CACHE%\nsis\tmp\*.exe" echo 完成
dir /s /b "%~dp0release\*.exe" 2>nul
echo.
echo 安装包已生成到 release 文件夹（Setup 前缀的 .exe 即为安装程序）。
echo.
pause