#!/bin/bash
cd "$(dirname "$0")/../agent" || exit 1
uv run python ../serve.py
