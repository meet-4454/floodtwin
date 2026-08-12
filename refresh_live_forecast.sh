#!/usr/bin/env bash
# Poll the partner for a new daily run and rebuild /live when the run_id changes.
#
# Runs from cron every 20 minutes. It polls for a new RUN_ID rather than firing
# at a guessed clock time: the partner's run is named for its 23:30 init but
# only becomes fetchable around 05:00–05:20 IST, and that window moves. When
# nothing has changed build_live_forecast.py exits in about half a second, so
# polling all day costs nothing.
#
# flock stops a slow rebuild from overlapping the next tick — a 20-minute cadence
# against a rebuild that can take several minutes will otherwise eventually run
# two builders at once, both writing the same stage directory.
#
# Install (no root needed — this is the invoking user's own crontab):
#   crontab -l | { cat; echo "*/20 * * * * /home/production/airesq/floodtwin/refresh_live_forecast.sh"; } | crontab -
set -uo pipefail

cd "$(dirname "$0")" || exit 1

# The builder needs numpy and pyproj. The gunicorn env deliberately has neither
# — it only ever serves the finished binaries — so the ETL runs on base conda.
PY="${FLOODTWIN_BUILD_PYTHON:-/home/production/miniconda3/bin/python}"
LOG="drainage/live_refresh.log"
LOCK="/tmp/floodtwin_live_refresh.lock"

mkdir -p drainage

exec 9>"$LOCK"
if ! flock -n 9; then
    echo "=== $(date -Is) refresh — another build still running, skipped ===" >>"$LOG"
    exit 0
fi

{
    echo "=== $(date -Is) refresh ==="
    "$PY" build_live_forecast.py "$@"
    echo "=== exit $? ==="
} >>"$LOG" 2>&1
