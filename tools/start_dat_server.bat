@echo off
chcp 65001 >nul
title dat.js 本地热更新服务
cd /d "%~dp0transpile"

if not exist "node_modules\@babel\core" (
    echo [启动] 首次运行，安装依赖中...
    call npm install
)

echo [启动] 正在启动 dat.js 本地服务 (http://127.0.0.1:8799/dat.js)
echo [提示] 保持本窗口开着；改 dat.js 保存后刷新考试页面即可热更新。关闭请按 Ctrl+C。
echo.
call npm run serve

echo.
echo [服务已退出] 按任意键关闭窗口...
pause >nul
