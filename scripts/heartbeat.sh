#!/bin/bash
#
# 주 1회 살아있음 신호. GUIDEBOOK.md 13.4
#
# ⚠️ launchd 는 PATH 가 비어 있고 CI 는 갖춰져 있다. 덮어쓰지 말고 덧붙인다.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

# launchd 는 PATH 가 /usr/bin:/bin 수준으로 비어 있고, CI 는 이미 제대로 갖춰져 있다.
# 기존 PATH 를 지우지 말고, 존재하는 경로만 앞에 덧붙인다.
for d in "$HOME/.local/bin" /opt/homebrew/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH="${PATH}:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/heartbeat.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] heartbeat 실행" >> "$LOG"
npx tsx src/cli/heartbeat.ts 2>&1 | sed 's/^/    /' >> "$LOG"

if [ "$(wc -l < "$LOG")" -gt 500 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
