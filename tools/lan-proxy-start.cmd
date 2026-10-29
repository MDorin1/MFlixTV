@echo off
chcp 65001 >nul
setlocal
set ROOT=D:\Backup\Documents\deepseek-harness\default-workspace\lihongguotv-desktop
set NODE=D:\Tools\nodejs\node.exe
if not exist "%NODE%" set NODE=node

echo ============================================
echo   MFlixTV LAN Proxy Bridge
echo   TV / box proxy:   http://%COMPUTERNAME%:7891
echo   health check:     http://192.168.2.201:7891/health
echo   关闭此窗口即停止转发
echo ============================================
echo.

"%NODE%" "%ROOT%\tools\lan-proxy.js" --verbose
pause
