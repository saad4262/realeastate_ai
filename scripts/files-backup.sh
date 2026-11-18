#!/usr/bin/env bash
# Daily copy of every Supabase Storage bucket to the backup S3 account (PLATFORM-PLAN 0.8). A database dump holds
# only the files' rows (`storage.objects`), never the files. Run by .github/workflows/files-backup.yml.
#
# rclone streams bucket to bucket (no local disk) and copies only what changed. A file deleted in Supabase is
# deleted here too, but the backup bucket is versioned with Object Lock: the old version stays (locked 14 days,
# expired at 35 by lifecycle), so a deletion or a ransomware wipe in Supabase is still recoverable.
#
# Needs: SUPABASE_S3_ENDPOINT, SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY (Supabase → Storage →
# S3 connection), BACKUP_FILES_S3_URI (s3://bucket/files), AWS credentials in the environment.
# Optional: HEALTHCHECK_URL. The rclone remotes can be swapped (RCLONE_CONFIG_SRC_*/DST_*) for a local test.
set -euo pipefail
: "${BACKUP_FILES_S3_URI:?}"

ping() { if [[ -n "${HEALTHCHECK_URL:-}" ]]; then curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}$1" >/dev/null || true; fi; }
ping /start
trap 'ping /fail' ERR

# Source: Supabase's S3 endpoint. Destination: AWS, credentials from the environment (the OIDC role).
if [[ -z "${RCLONE_CONFIG_SRC_TYPE:-}" ]]; then
  : "${SUPABASE_S3_ENDPOINT:?}" "${SUPABASE_S3_ACCESS_KEY_ID:?}" "${SUPABASE_S3_SECRET_ACCESS_KEY:?}"
  export RCLONE_CONFIG_SRC_TYPE=s3 RCLONE_CONFIG_SRC_PROVIDER=Other RCLONE_CONFIG_SRC_REGION=ap-southeast-2
  export RCLONE_CONFIG_SRC_ENDPOINT="$SUPABASE_S3_ENDPOINT"
  export RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$SUPABASE_S3_ACCESS_KEY_ID" RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$SUPABASE_S3_SECRET_ACCESS_KEY"
fi
if [[ -z "${RCLONE_CONFIG_DST_TYPE:-}" ]]; then
  export RCLONE_CONFIG_DST_TYPE=s3 RCLONE_CONFIG_DST_PROVIDER=AWS RCLONE_CONFIG_DST_ENV_AUTH=true RCLONE_CONFIG_DST_REGION=ap-southeast-4
fi
dst="dst:${BACKUP_FILES_S3_URI#s3://}"
dst="${dst%/}"

# Every bucket, so a new one is never silently left out. No bucket at all is a broken source, not an empty one.
buckets=$(rclone lsf src: --dirs-only | sed 's:/$::')
[[ -n "$buckets" ]] || { echo "Refusing: the source lists no buckets" >&2; false; }

total=0
for b in $buckets; do
  # Storage keys are random per upload and never rewritten, so size + the server's modified time is enough.
  rclone sync "src:$b" "$dst/$b" --use-server-modtime --fast-list --transfers 16 --checkers 32 --stats-one-line --stats 0
  # Proof, not trust: every source file is now in the backup with the same size.
  rclone check "src:$b" "$dst/$b" --one-way --size-only
  n=$(rclone size "src:$b" --json | sed -E 's/.*"count":([0-9]+).*/\1/')
  echo "$b: $n files"
  total=$((total + n))
done
echo "$(date -u +%Y%m%dT%H%M%SZ)  buckets=$(echo "$buckets" | wc -w | tr -d ' ')  files=$total"
ping ""
