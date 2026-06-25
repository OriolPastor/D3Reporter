#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_LOCAL="$ROOT_DIR/.env.local"
FRONTEND_ENV="$ROOT_DIR/frontend/.env"

if [ ! -f "$ENV_LOCAL" ]; then
  echo "Warning: $ENV_LOCAL not found, using defaults (localhost:80)"
  echo "VITE_DIRECTOR_HOST=localhost" > "$FRONTEND_ENV"
  echo "VITE_DIRECTOR_PORT=80" >> "$FRONTEND_ENV"
  exit 0
fi

echo "# Auto-generated from .env.local - DO NOT EDIT" > "$FRONTEND_ENV"
while IFS='=' read -r key value || [ -n "$key" ]; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  case "$key" in
    DIRECTOR_HOST) echo "VITE_DIRECTOR_HOST=$value" >> "$FRONTEND_ENV" ;;
    DIRECTOR_PORT) echo "VITE_DIRECTOR_PORT=$value" >> "$FRONTEND_ENV" ;;
  esac
done < "$ENV_LOCAL"

echo "Generated $FRONTEND_ENV"
