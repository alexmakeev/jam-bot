#!/bin/bash
# Install a persistent receiver and the operator's scoped Git publisher as user services.
set -euo pipefail
umask 077
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: install-service.sh /path/to/service.env [/path/to/publisher.json]' >&2
  exit 2
fi
config=$(realpath "$1")
publisher=${2:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
base="$HOME/.jam-bot/service"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
node_path=${JAM_HOST_NODE:-$(command -v node)}
docker_path=$(command -v docker)
[[ -r "$config" && ( -z "$publisher" || -r "$publisher" ) ]]
case "$node_path$docker_path" in *[\"\%\\\$]*|*$'\n'*) echo 'Unsupported executable path' >&2; exit 1;; esac
"$node_path" -e "require('node:sqlite')" >/dev/null
"$docker_path" info >/dev/null
"$docker_path" compose version >/dev/null
if [[ ! -x "$root/node_modules/.bin/tsc" ]]; then (cd "$root" && npm ci); fi
mkdir -p "$base/publisher/runtime" "$HOME/.jam-bot/profile-exchange" "$HOME/.jam-bot/container-home" "$HOME/.claude" "$units"
export JAM_HOST_NODE="$node_path"
"$root/scripts/linux/install-environment-host.sh"
if [[ ! "$config" -ef "$base/service.env" ]]; then install -m 600 "$config" "$base/service.env"; fi
server_id=$(cat "$HOME/.jam-bot/management/server-id")
if ! grep -q '^JAM_SERVER_ID=' "$base/service.env"; then printf '\nJAM_SERVER_ID=%s\n' "$server_id" >> "$base/service.env"; fi
# Linux bind mounts use the operator's actual UID and GID. Docker Desktop keeps the image defaults.
for setting in UID GID; do
  if ! grep -q "^JAM_RUNTIME_$setting=" "$base/service.env"; then
    if [[ $setting == UID ]]; then value=$(id -u); else value=$(id -g); fi
    printf 'JAM_RUNTIME_%s=%s\n' "$setting" "$value" >> "$base/service.env"
  fi
done
install -m 600 "$root/compose.service.yaml" "$base/compose.service.yaml"
compose=("$docker_path" compose --env-file "$base/service.env" -f "$base/compose.service.yaml")
"${compose[@]}" config --quiet
image=$("${compose[@]}" config --images)
if ! "$docker_path" image inspect "$image" >/dev/null 2>&1; then
  if [[ "$image" != jam-bot-local-service:latest ]]; then echo 'Load the selected receiver image before installation.' >&2; exit 1; fi
  "$docker_path" build -t "$image" "$root"
fi
runtime=$("${compose[@]}" config --format json | "$node_path" -p "JSON.parse(require('fs').readFileSync(0)).services.receiver.user")
[[ "$runtime" =~ ^[0-9]+:[0-9]+$ ]]
"${compose[@]}" run --rm --no-deps --user 0:0 --entrypoint sh receiver -ceu '
  expected=$1
  if [ "$(stat -c %u:%g /var/lib/jam)" != "$expected" ]; then
    if [ -n "$(ls -A /var/lib/jam)" ]; then echo "Existing state has a different owner; retain the original service identity." >&2; exit 1; fi
    chown "$expected" /var/lib/jam
  fi' sh "$runtime"
exchange=$("${compose[@]}" config --format json | "$node_path" -p "JSON.parse(require('fs').readFileSync(0)).services.receiver.volumes.find(v=>v.target==='/var/lib/jam-profile-exchange').source")
case "$exchange" in *[\"\%\\\$]*|*$'\n'*) echo 'Unsupported publisher exchange path' >&2; exit 1;; esac
install -m 600 "$root/scripts/macos/validation-recovery.mjs" "$root/scripts/macos/profile-broker.mjs" "$root/scripts/macos/integration-pr.mjs" "$root/scripts/macos/git-scope.mjs" "$root/scripts/macos/profile-recipes.mjs" "$root/scripts/macos/own-management-smoke.mjs" "$root/scripts/macos/static-quality.mjs" "$root/scripts/macos/unit-reporter.mjs" "$root/scripts/macos/calculator-deployment.mjs" "$root/scripts/macos/consultant-workspace.mjs" "$root/scripts/macos/consultants.mjs" "$root/scripts/macos/antigravity-consultant.mjs" "$base/publisher/"
install -m 600 "$root/dist/src/project-values-reader.js" "$root/dist/src/profile-card.js" "$root/dist/src/broker-approval.js" "$base/publisher/runtime/"
printf '%s\n' '{"type":"module"}' > "$base/publisher/runtime/package.json"
if [[ -n "$publisher" ]]; then
  "$node_path" --input-type=module - "$base/publisher/profile-recipes.mjs" "$publisher" <<'JS'
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [recipes,path]=process.argv.slice(2);
const {projectRecipes}=await import(pathToFileURL(recipes));
projectRecipes(JSON.parse(readFileSync(path,'utf8')));
JS
  if [[ ! "$publisher" -ef "$base/publisher/config.json" ]]; then install -m 600 "$publisher" "$base/publisher/config.json"; fi
elif [[ ! -e "$base/publisher/config.json" ]]; then printf '%s\n' '{"projects":{}}' > "$base/publisher/config.json"; fi
cat > "$units/jam-bot-receiver.service" <<UNIT
[Unit]
Description=JAM-Bot repository receiver
StartLimitIntervalSec=0
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=%h/.jam-bot/service
ExecStart="$docker_path" compose --env-file service.env -f compose.service.yaml up --wait --wait-timeout 90 -d
ExecReload="$docker_path" compose --env-file service.env -f compose.service.yaml up --wait --wait-timeout 90 -d
ExecStop="$docker_path" compose --env-file service.env -f compose.service.yaml stop --timeout 30
TimeoutStartSec=120
Restart=on-failure
RestartSec=5
UMask=0077
[Install]
WantedBy=default.target
UNIT
cat > "$units/jam-bot-publisher.service" <<UNIT
[Unit]
Description=JAM-Bot scoped Git bundle publisher
[Service]
Type=oneshot
WorkingDirectory=%h/.jam-bot/service/publisher
Environment="PATH=$(dirname "$docker_path"):$(dirname "$node_path"):/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/flock -n -F "%h/.jam-bot/service/publisher/owner.lock" "$node_path" profile-broker.mjs "$exchange" config.json
UMask=0077
UNIT
cat > "$units/jam-bot-publisher.timer" <<'UNIT'
[Unit]
Description=Wake the JAM-Bot Git publisher
[Timer]
OnStartupSec=1s
OnUnitInactiveSec=3s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable jam-bot-receiver.service jam-bot-publisher.timer
systemctl --user start jam-bot-publisher.service
systemctl --user restart jam-bot-publisher.timer
systemctl --user reload-or-restart jam-bot-receiver.service
systemctl --user is-active --quiet jam-bot-receiver.service jam-bot-publisher.timer
if [[ $(loginctl show-user "$(id -u)" -p Linger --value) != yes ]]; then
  loginctl enable-linger "$(id -un)" || { echo "Enable unattended startup with: sudo loginctl enable-linger $(id -un)" >&2; exit 1; }
fi
printf 'Receiver and publisher active. Installed configuration: %s\n' "$base"
