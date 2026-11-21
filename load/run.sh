#!/usr/bin/env bash
# PLATFORM-PLAN 4.3: one load run, with everything it saw kept in load/runs/<time>/ and an HTML report at the end.
# First load the dev values:  set -a; source .env.dev; set +a
# Then, for example:           load/run.sh -e MODE=run -e PROFILE=pop -e AGENCIES=200 -e AGENTS=1000 -e USERS=10000 \
#                                -e STRIPE_WEBHOOK_SECRET=whsec_load_test   (servers: WEB, AGENTS_URL, AGENCY_URL, ADMIN_URL)
# WEB_LOG / CONSOLE_LOG: the servers' log files, if they run on this machine (their errors go into the report).
set -euo pipefail
[[ -n "${DIRECT_URL:-}" ]] || { echo "Load .env.dev first (DIRECT_URL is not set)"; exit 1; }
[[ "$DIRECT_URL" != *xjklpoyxcvnlhjlxasmv* ]] || { echo "Refusing: that is the production database"; exit 1; }
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/opt/libpq/bin/psql)}"
# Log paths given relative to where run.sh was started still work after the cd below.
[[ -n "${WEB_LOG:-}" && -f "$WEB_LOG" ]] && WEB_LOG="$(cd "$(dirname "$WEB_LOG")" && pwd)/$(basename "$WEB_LOG")"
[[ -n "${CONSOLE_LOG:-}" && -f "$CONSOLE_LOG" ]] && CONSOLE_LOG="$(cd "$(dirname "$CONSOLE_LOG")" && pwd)/$(basename "$CONSOLE_LOG")"
cd "$(dirname "$0")"
OUT="runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "$*" > "$OUT/args.txt"
# The -e settings k6 gets (servers, population) also reach profile.mjs and report.mjs.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "-e" && $((i + 1)) -lt ${#args[@]} ]]; then export "${args[$((i + 1))]}"; fi
done
# Where each server log stands now, so only this run's lines are read afterwards.
WEB_FROM=0; CONSOLE_FROM=0
[[ -n "${WEB_LOG:-}" && -f "$WEB_LOG" ]] && WEB_FROM=$(wc -c < "$WEB_LOG")
[[ -n "${CONSOLE_LOG:-}" && -f "$CONSOLE_LOG" ]] && CONSOLE_FROM=$(wc -c < "$CONSOLE_LOG")

# Each request alone first (SKIP_PROFILE=1 to skip): its time and database statements, to explain the run.
if [[ -z "${SKIP_PROFILE:-}" ]]; then
  node profile.mjs "$OUT/profile.json" | tee "$OUT/profile.txt"
fi
echo "DB_POOL_MAX=${DB_POOL_MAX:-5 (default)}" >> "$OUT/args.txt"
# The load generator's own limits, for the report's "was this a valid test?" (k6: "Running large tests").
{
  echo "CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  echo "ULIMIT_N=$(ulimit -n)"
  echo "SOMAXCONN=$(sysctl -n kern.ipc.somaxconn 2>/dev/null || cat /proc/sys/net/core/somaxconn 2>/dev/null || echo ?)"
} >> "$OUT/args.txt"

START=$(date +%s)
echo "START=$START" >> "$OUT/args.txt"
node sampler.mjs "$OUT/samples.csv" 2> "$OUT/sampler.log" &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

# Every request goes into k6.csv.gz; k6 exits non-zero when a threshold fails, which is a result, not an error here.
# k6's own HTML report beside ours (no HTTP port opened).
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_PORT=-1 K6_WEB_DASHBOARD_EXPORT="$OUT/k6-dashboard.html" \
k6 run --out "csv=$OUT/k6.csv.gz" --summary-export "$OUT/summary.json" "$@" platform.js 2> "$OUT/k6.log" | tee "$OUT/k6-console.txt" || true

kill "$SAMPLER" 2>/dev/null || true
wait "$SAMPLER" 2>/dev/null || true
"$PSQL" "$DIRECT_URL" -q -f after-run.sql > "$OUT/after-run.txt" 2>&1 || true
"$PSQL" "$DIRECT_URL" -Atc "select count(*) from site_activity where created_at >= to_timestamp($START)" > "$OUT/activity-rows.txt" 2>&1 || true
for app in WEB CONSOLE; do
  log="${app}_LOG"; from="${app}_FROM"
  if [[ -n "${!log:-}" && -f "${!log}" ]]; then
    name=$(echo "$app" | tr '[:upper:]' '[:lower:]')
    tail -c +$(( ${!from} + 1 )) "${!log}" > "$OUT/$name-server.log"
    grep -i -E "error|warn|timeout|ECONN|refused|too many" "$OUT/$name-server.log" > "$OUT/$name-errors.txt" || true
  fi
done
node report.mjs "$OUT"
echo "Report: load/$OUT/report.html"
