#!/usr/bin/env bash
# Deploy Rocky to a host. Usage: deploy/push.sh [ssh-host] [remote-dir]
set -euo pipefail
HOST="${1:-aws-server}"
DIR="${2:-/home/ubuntu/rocky}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

rsync -az --delete-after \
  --exclude-from "$HERE/deploy/rsync-exclude.txt" \
  "$HERE/" "$HOST:$DIR/"

echo "pushed $HERE -> $HOST:$DIR"
echo "restart with: ssh $HOST 'sudo systemctl restart rocky-gateway'"
