#!/bin/bash
set -euo pipefail
umask 077
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 /absolute/path/to/service.env [/absolute/path/to/tunnel.sh]" >&2
  exit 2
fi
config=$1
route=${2:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
base="$HOME/Library/Application Support/JAM-Bot"
label=local.jam-bot.service
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
[[ -r "$config" ]]
[[ -z "$route" || -x "$route" ]]
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  echo "Service already installed and loaded. Use the upgrade steps in docs/SERVICE.md." >&2
  exit 1
fi
mkdir -p "${JAM_PROFILE_EXCHANGE:-$HOME/.jam-bot/profile-exchange}"
docker compose --env-file "$config" -f "$root/compose.service.yaml" config -q
docker build -t jam-bot-local-service:latest "$root"
mkdir -p "$base" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/JAM-Bot"
install -m 600 "$root/compose.service.yaml" "$base/compose.service.yaml"
if [[ ! "$config" -ef "$base/service.env" ]]; then install -m 600 "$config" "$base/service.env"; fi
install -m 700 "$root/scripts/macos/run-service.sh" "$base/run-service.sh"
if [[ -n "$route" ]]; then
  if [[ ! "$route" -ef "$base/tunnel.sh" ]]; then install -m 700 "$route" "$base/tunnel.sh"; fi
elif [[ -e "$base/tunnel.sh" ]]; then
  echo "A previous tunnel recipe exists. Pass it explicitly or move it before reinstalling." >&2
  exit 1
fi
# Let the property-list API escape paths, including user-chosen home directories.
plutil -create xml1 "$plist"
plutil -insert Label -string "$label" "$plist"
plutil -insert ProgramArguments -array "$plist"
plutil -insert ProgramArguments.0 -string "$base/run-service.sh" "$plist"
plutil -insert RunAtLoad -bool true "$plist"
plutil -insert KeepAlive -bool true "$plist"
plutil -insert ThrottleInterval -integer 15 "$plist"
plutil -insert StandardOutPath -string "$HOME/Library/Logs/JAM-Bot/service.log" "$plist"
plutil -insert StandardErrorPath -string "$HOME/Library/Logs/JAM-Bot/service.log" "$plist"
plutil -lint "$plist"
launchctl enable "$domain/$label"
launchctl bootstrap "$domain" "$plist"
