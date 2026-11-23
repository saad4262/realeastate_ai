#!/usr/bin/env bash
# PLATFORM-PLAN 4.3: the two apps on this machine for a load run — production builds, the DEV database, every vendor
# key replaced so nothing real is called (no AI, email, SMS, maps, OAuth; Stripe only with the test secret below).
#   load/local-servers.sh build    production builds into .next-load (a few minutes)
#   load/local-servers.sh start    web on :3000, console on :3001; logs in load/runs/servers/
#   load/local-servers.sh stop
# Then: load/run.sh … -e STRIPE_WEBHOOK_SECRET=whsec_load_test, with WEB_LOG/CONSOLE_LOG as printed by start.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env.dev ]] || { echo ".env.dev is missing (the dev database's values)"; exit 1; }
set -a; source .env.dev; set +a
[[ "${DIRECT_URL:-}${NEXT_PUBLIC_SUPABASE_URL:-}" != *xjklpoyxcvnlhjlxasmv* ]] || { echo "Refusing: .env.dev points at production"; exit 1; }

# Values set here win over .env.local (Next.js never overrides a variable the process already has).
export ANTHROPIC_API_KEY=load-test-disabled RESEND_API_KEY=load-test-disabled GOOGLE_MAPS_API_KEY=load-test-disabled
export VOYAGE_API_KEY=load-test-disabled RETELL_API_KEY=load-test-disabled
export GOOGLE_OAUTH_CLIENT_ID=load-test-disabled GOOGLE_OAUTH_CLIENT_SECRET=load-test-disabled
export ZOOM_OAUTH_CLIENT_ID=load-test-disabled ZOOM_OAUTH_CLIENT_SECRET=load-test-disabled
export INTEGRATIONS_STUB= PHONE_STUB=1 AI_DAILY_BUDGET_USD=0 EMAIL_DEV_ALLOWLIST=nobody@load.test SMS_DEV_ALLOWLIST=+61400000000
export STRIPE_SECRET_KEY= STRIPE_WEBHOOK_SECRET=whsec_load_test NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=.next-load
# Made once and kept, so a restart does not sign everyone out or break the stored test integration rows.
KEYS=load/runs/servers/keys.env
mkdir -p load/runs/servers
[[ -f "$KEYS" ]] || printf 'SESSION_HEADER_SECRET=%s\nINTEGRATION_TOKEN_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > "$KEYS"
set -a; source "$KEYS"; set +a

case "${1:-}" in
  build)
    pnpm --filter @repo/web build
    pnpm --filter @repo/console build
    # The builds write their own folder into these files; they are not part of any change.
    git restore apps/web/next-env.d.ts apps/web/tsconfig.json apps/console/next-env.d.ts apps/console/tsconfig.json 2>/dev/null || true
    ;;
  start)
    ulimit -n 10240 || true
    nohup pnpm --filter @repo/web start > load/runs/servers/web.log 2>&1 &
    nohup pnpm --filter @repo/console start > load/runs/servers/console.log 2>&1 &
    for _ in $(seq 1 60); do
      grep -q Ready load/runs/servers/web.log 2>/dev/null && grep -q -E 'Ready|Refusing' load/runs/servers/console.log 2>/dev/null && break
      sleep 1
    done
    tail -n 2 load/runs/servers/web.log load/runs/servers/console.log
    echo "WEB_LOG=$PWD/load/runs/servers/web.log CONSOLE_LOG=$PWD/load/runs/servers/console.log"
    ;;
  stop)
    for port in 3000 3001; do lsof -iTCP:$port -sTCP:LISTEN -t | xargs kill 2>/dev/null || true; done
    echo stopped
    ;;
  *) echo "usage: load/local-servers.sh build|start|stop"; exit 1 ;;
esac
