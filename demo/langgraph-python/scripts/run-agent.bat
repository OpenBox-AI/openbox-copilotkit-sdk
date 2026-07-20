@echo off
cd /d "%~dp0..\agent"
uv run python ..\serve.py
