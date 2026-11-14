#!/bin/bash
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then
  echo "Usage: $0 OWNER/REPO IMAGE_FOR_ISOLATED_TESTS" >&2; exit 2
fi
repo=$1
image=$2
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
docker image inspect "$image" >/dev/null
gh api "repos/$repo" --jq '.permissions.push' | grep -qx true
dir="$HOME/Library/Application Support/JAM-Bot/profile-broker"
exchange="$HOME/.jam-bot/profile-exchange"
label=local.jam-bot.profile-broker
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$dir" "$exchange" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/JAM-Bot"
install -m 700 "$(dirname "$0")/profile-broker.mjs" "$dir/profile-broker.mjs"
node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({repositories:[process.argv[2]],image:process.argv[3]}))" "$dir/config.json" "$repo" "$image"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
plutil -create xml1 "$plist"
plutil -insert Label -string "$label" "$plist"
plutil -insert ProgramArguments -array "$plist"
plutil -insert ProgramArguments.0 -string "$(command -v node)" "$plist"
plutil -insert ProgramArguments.1 -string "$dir/profile-broker.mjs" "$plist"
plutil -insert ProgramArguments.2 -string "$exchange" "$plist"
plutil -insert ProgramArguments.3 -string "$dir/config.json" "$plist"
plutil -insert EnvironmentVariables -dictionary "$plist"
plutil -insert EnvironmentVariables.PATH -string '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' "$plist"
plutil -insert RunAtLoad -bool true "$plist"
plutil -insert StartInterval -integer 4 "$plist"
plutil -insert StandardErrorPath -string "$HOME/Library/Logs/JAM-Bot/profile-broker.log" "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
