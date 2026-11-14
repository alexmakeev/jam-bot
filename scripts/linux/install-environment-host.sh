#!/bin/bash
# Install as the Linux user who owns the Docker environment recipes.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd)
node_path=${JAM_HOST_NODE:-$(command -v node)}
"$root/scripts/prepare-environment-host.sh"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
case "$node_path" in *[\"\%\\\$]*|*$'\n'*) echo 'Unsupported Node executable path' >&2; exit 1;; esac
cat > "$unit_dir/jam-bot-environments.service" <<UNIT
[Unit]
Description=JAM-Bot environment deployment runner

[Service]
Type=simple
ExecStart=/usr/bin/flock -n -F "%h/.jam-bot/management/runner.lock" "$node_path" "%h/.jam-bot/management/runtime/environment-host.mjs" "%h/.jam-bot/management" "%h/.jam-bot/management-exchange" "%h/.jam-bot/management/owner.token"
Restart=on-failure
RestartSec=5s
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable jam-bot-environments.service
systemctl --user restart jam-bot-environments.service
systemctl --user is-active --quiet jam-bot-environments.service
