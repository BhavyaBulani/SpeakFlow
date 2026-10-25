@echo off
REM Detached launcher for the built SpeakFlow server.
REM Used for local smoke testing: sets mock AI so replies are deterministic and
REM no provider key is needed, then starts node with its own log handles so the
REM calling shell returns immediately.
setlocal
cd /d "%~dp0.."
if "%MOCK_AI%"=="" set MOCK_AI=1
set NODE_ENV=development
start "" /B node dist\server\index.js > .server.log 2> .server.err.log
endlocal
