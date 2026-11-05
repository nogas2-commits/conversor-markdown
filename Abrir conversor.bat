@echo off
cd /d "%~dp0"
echo Abrindo o Conversor para Markdown em http://localhost:8765
echo Deixe esta janela aberta enquanto usa. Feche para encerrar.
start "" http://localhost:8765
python -m http.server 8765 --bind 127.0.0.1
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar. Este atalho precisa do Python instalado.
  pause
)
