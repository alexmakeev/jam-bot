#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
if ! docker info >/dev/null 2>&1; then
  /usr/bin/open -g -a Docker
  until docker info >/dev/null 2>&1; do sleep 5; done
fi
docker compose --env-file service.env -f compose.service.yaml up --wait --wait-timeout 45 -d
if [[ -x ./tunnel.sh ]]; then exec ./tunnel.sh; fi
# Keep the agent attached to the managed container until Docker exits.
exec docker wait "$(docker compose --env-file service.env -f compose.service.yaml ps -q receiver)"
