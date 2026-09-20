#!/usr/bin/env bash
# Self-Healer stack startup: daemon → readiness gate → cloudflared quick tunnel.
# Ordering prevents the "tunnel up, daemon down → connection refused → dropped
# webhook" failure: the tunnel is only launched once :3457 answers /health.
# (plan.md "Addendum: Deployment Reliability Fix", T060)

set -euo pipefail

echo "▶ ensuring self-healer daemon is running (systemd)..."
systemctl --user start self-healer

echo "▶ waiting for :3457 readiness (GET /health → 200)..."
code=""
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3457/health || true)
  [ "$code" = "200" ] && break
  sleep 1
done
if [ "${code:-}" != "200" ]; then
  echo "✗ daemon not ready after 30s (last HTTP status: ${code:-none}) — aborting, tunnel NOT started" >&2
  exit 1
fi

echo "▶ :3457 ready (HTTP 200) — starting cloudflared tunnel"
echo "  Quick-tunnel URLs are session-random. When this prints a"
echo "  https://*.trycloudflare.com URL, re-set the repo secret:"
echo "  gh secret set SELF_HEALER_URL <url> -R <owner/repo>"
exec cloudflared tunnel --url http://localhost:3457