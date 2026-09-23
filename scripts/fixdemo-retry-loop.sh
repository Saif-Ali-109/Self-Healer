#!/usr/bin/env bash
# Self-Healer demo auto-retry: re-trigger the demo-repo CI whenever the last run
# escalated on a transient LLM demand error, until a fix is delivered or the
# outcome becomes terminal (non-LLM escalation / resolved / max attempts).
set -u

PROJECT="/home/ain/Desktop/healer agent/Healer Agent"
DB="$PROJECT/data/self-healer.db"
CLONE="/home/ain/Desktop/demo-repo"
BRANCH="demo-real-bugs"
MAX=14
i=0

log() { echo "$(date '+%H:%M:%S') $*"; }

while [ "$i" -lt "$MAX" ]; do
  # One-line state probe: status|hasFixForLatest|lastEscReason
  state=$(node -e '
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const r = db.prepare("SELECT run_id, status FROM ci_runs ORDER BY created_at DESC LIMIT 1").get();
  const f = r ? db.prepare("SELECT COUNT(*) n FROM fix_attempts WHERE run_id = ?").get(r.run_id) : { n: 0 };
  const e = db.prepare("SELECT reason FROM escalations ORDER BY rowid DESC LIMIT 1").get();
  console.log(`${r?.status ?? "none"}|${f?.n ?? 0}|${e?.reason ?? ""}`);
} catch (err) {
  console.log(`dberr|0|${String(err).slice(0, 40)}`);
}' "$DB" 2>/dev/null)

  IFS='|' read -r status hasFix lastEsc <<< "$state"
  log "state=${state:-empty} attempt=$i/$MAX"

  case "$status" in
    dberr|none|"")
      log "DB unreadable; waiting."
      sleep 60; continue
      ;;
    resolved)
      log "SUCCESS: latest run resolved."
      exit 0
      ;;
    pending|classifying|fixing)
      sleep 60; continue
      ;;
    escalated)
      if [ "${hasFix:-0}" -gt 0 ]; then
        log "SUCCESS: fix delivered despite escalation."
        exit 0
      fi
      if [ "$lastEsc" = "llm_unavailable" ]; then
        log "transient LLM demand error; re-triggering CI."
        if ! (cd "$CLONE" && git commit -q --allow-empty -m "demo: auto-retry (llm demand spike)" \
              && git push origin "$BRANCH" >/dev/null 2>&1); then
          log "push failed (auth?); not counting attempt."
          sleep 60; continue
        fi
        i=$((i + 1))
        sleep 240
        continue
      fi
      log "terminal escalation: $lastEsc — stopping loop (needs human)."
      exit 0
      ;;
    *)
      log "unknown status '$status'; waiting."
      sleep 60; continue
      ;;
  esac
done

log "max attempts reached; stopping."
exit 0
