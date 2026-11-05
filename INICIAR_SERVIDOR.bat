@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo             MECCHA 2D - SERVIDOR
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado.
  echo Instale o Node.js LTS e execute este arquivo novamente.
  pause
  exit /b 1
)
echo.
echo Iniciando servidor sem instalar dependencias extras...
echo.
node server.js
pause
