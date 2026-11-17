@echo off
cd /d "%~dp0"
if not exist "%~dp0demo-team.json" copy /y "%~dp0demo-team.example.json" "%~dp0demo-team.json" >nul
set "OPENGROKBOT_TEAM=%~dp0demo-team.json"
set "OPENGROKBOT_DATA=%~dp0demo-data"
node dist\server\index.js
