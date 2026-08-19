#!/usr/bin/env bash
# Nightly backup of the funnel database.
#
#   TWO_DB_PATH=./data/two.db TWO_BACKUP_DIR=./backups bash scripts/backup.sh
#
# Restore: stop the bot, gunzip a snapshot over data/two.db, start the bot.
#   sudo systemctl stop two-bot
#   gunzip -c /var/backups/two-bot/two-<stamp>.db.gz > /opt/two-bot/data/two.db
#   sudo systemctl start two-bot

set -euo pipefail

DB="${TWO_DB_PATH:-./data/two.db}"
DEST="${TWO_BACKUP_DIR:-./backups}"
KEEP="${TWO_BACKUP_KEEP:-14}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$DB" ]; then
  echo "backup: no database at $DB - nothing to do" >&2
  exit 0
fi

mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/two-$STAMP.db"

# Snapshot + verify. Fails loudly rather than leaving a bad backup behind.
node "$HERE/snapshot.ts" "$DB" "$OUT"

gzip -f "$OUT"
echo "backup: wrote $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Retention: keep the newest $KEEP snapshots.
find "$DEST" -maxdepth 1 -name 'two-*.db.gz' -type f -printf '%T@ %p\n' \
  | sort -rn | tail -n "+$((KEEP + 1))" | cut -d' ' -f2- \
  | while read -r old; do echo "backup: pruning $old"; rm -f "$old"; done

echo "backup: done"
