#!/usr/bin/env bash
# Off-site, encrypted backup of the production database (PLATFORM-PLAN 0.4). Run by .github/workflows/db-backup.yml.
#
# Encrypted to an age PUBLIC key: this job can write a backup but can never read one. The private key lives only in
# the password manager. Decrypt and restore:
#   age -d -i key.txt prod-<stamp>.dump.age > prod.dump && pg_restore --list prod.dump
#
# Needs: BACKUP_DATABASE_URL (session pooler, 5432), BACKUP_AGE_RECIPIENT (age1…), BACKUP_S3_URI (s3://bucket/prefix),
# AWS credentials in the environment. Optional: HEALTHCHECK_URL (healthchecks.io ping URL), BACKUP_MIN_TABLES, BACKUP_MIN_AGENCIES.
set -euo pipefail
: "${BACKUP_DATABASE_URL:?}" "${BACKUP_AGE_RECIPIENT:?}" "${BACKUP_S3_URI:?}"

ping() { if [[ -n "${HEALTHCHECK_URL:-}" ]]; then curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}$1" >/dev/null || true; fi; }
ping /start
trap 'ping /fail' ERR

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
plain="$work/prod.dump"
out="$work/prod-$stamp.dump.age"

pg_dump --format=custom --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL" --file="$plain"

# A dump that is not a real one must fail the run (and the alert), not be stored as if it were. pg_restore lists
# every table whether or not it holds rows, so the schema is checked from the dump and the data from the database.
tables=$(pg_restore --list "$plain" | grep -c ' TABLE DATA ' || true)
agencies=$(psql "$BACKUP_DATABASE_URL" -Atc 'select count(*) from public.agency')
if (( tables < ${BACKUP_MIN_TABLES:-100} || agencies < ${BACKUP_MIN_AGENCIES:-1} )); then
  echo "Refusing to store this dump: $tables tables, $agencies agencies" >&2
  false
fi

age -r "$BACKUP_AGE_RECIPIENT" -o "$out" "$plain"
rm -f "$plain"
aws s3 cp "$out" "${BACKUP_S3_URI%/}/$(basename "$out")" --only-show-errors
echo "$stamp  $(du -h "$out" | cut -f1)  tables=$tables agencies=$agencies  sha256=$(sha256sum "$out" | cut -d' ' -f1)  $(basename "$out")"
ping ""
