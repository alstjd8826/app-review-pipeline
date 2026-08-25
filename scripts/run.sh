#!/bin/bash
#
# 파이프라인 한 바퀴: 수집 → 처리 → 알림
# launchd 에서 호출된다.
#
# ⚠️ launchd 는 로그인 셸을 거치지 않아 PATH 가 거의 비어 있다.
#    반대로 CI 에서는 이미 갖춰져 있으므로 덮어쓰면 안 된다.

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
LOG="$LOG_DIR/run.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "───── 시작 ─────"

# 도구 확인. 없으면 조용히 실패하지 말고 로그를 남긴다
for bin in node npx claude; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "✗ $bin 을 찾을 수 없다. PATH=$PATH"
    exit 1
  fi
done

run_step() {
  local name="$1"
  shift
  log "▶ $name"
  if output=$("$@" 2>&1); then
    echo "$output" | sed 's/^/    /' >> "$LOG"
    return 0
  else
    log "✗ $name 실패"
    echo "$output" | sed 's/^/    /' >> "$LOG"
    return 1
  fi
}

# 원격 저장소를 쓰는 환경이면 먼저 내려받는다. 미설정이면 아무 일도 안 한다
run_step "DB 내려받기" npx tsx src/cli/db-sync.ts pull || { log "───── 중단 ─────"; exit 1; }

# 수집이 실패하면 뒤는 의미가 없다
run_step "수집"   npx tsx src/cli/ingest.ts  || { log "───── 중단 ─────"; exit 1; }
run_step "처리"   npx tsx src/cli/process.ts || { log "───── 중단 ─────"; exit 1; }
run_step "알림"   npx tsx src/cli/notify.ts

# 알림이 실패해도 수집·처리 결과는 남겨야 하므로 여기서 올린다
run_step "DB 올리기" npx tsx src/cli/db-sync.ts push

log "───── 완료 ─────"

# 로그가 무한정 커지지 않게 최근 2000줄만 남긴다
if [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
