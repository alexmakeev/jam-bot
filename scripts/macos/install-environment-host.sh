#!/bin/bash
# Install the management-only Docker broker under the signed-in Mac user's LaunchAgent.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$HOME/.jam-bot/management"
exchange="$HOME/.jam-bot/management-exchange"
label=local.jam-bot.environment-host
plist="$HOME/Library/LaunchAgents/$label.plist"
node_path=${JAM_HOST_NODE:-$(command -v node)}
"$root/scripts/prepare-environment-host.sh"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/JAM-Bot"
domain="gui/$(id -u)"
launchctl bootout "$domain/$label" 2>/dev/null || true
plutil -create xml1 "$plist"
plutil -insert Label -string "$label" "$plist"
plutil -insert ProgramArguments -array "$plist"
args=(/usr/bin/lockf -k -t 0 "$dir/runner.lock" "$node_path" "$dir/runtime/environment-host.mjs" "$dir" "$exchange" "$dir/owner.token")
for i in "${!args[@]}"; do plutil -insert "ProgramArguments.$i" -string "${args[$i]}" "$plist"; done
plutil -insert EnvironmentVariables -dictionary "$plist"
plutil -insert EnvironmentVariables.PATH -string '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' "$plist"
plutil -insert RunAtLoad -bool true "$plist"
plutil -insert KeepAlive -bool true "$plist"
plutil -insert ThrottleInterval -integer 5 "$plist"
plutil -insert StandardErrorPath -string "$HOME/Library/Logs/JAM-Bot/environment-host.log" "$plist"
launchctl bootstrap "$domain" "$plist"
printf 'Private operator token: %s\nServer identity: %s\n' "$dir/owner.token" "$(cat "$dir/server-id")"
