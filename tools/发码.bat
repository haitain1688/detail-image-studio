@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   详情图工作台 - 发码工具
echo   私钥只在这台电脑上，别把这个目录发给客户。
echo.
where node >nul 2>nul
if %errorlevel%==0 (
  node issue-license.mjs %*
) else (
  "C:\Users\abyub\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" issue-license.mjs %*
)
echo.
pause
