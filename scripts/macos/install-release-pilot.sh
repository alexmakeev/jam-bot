#!/bin/bash
set -euo pipefail
umask 077
node_bin=${1:-$(command -v node)}
"$node_bin" -e "require('node:sqlite')"
root="$HOME/.jam-bot/management"
runtime="$root/calculator-release-pilot/runtime"
label=local.jam-bot.calculator-release
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$runtime" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/JAM-Bot"
test -f "$root/calculator-release-pilot/config.json"
for src in release-pilot.mjs profile-recipes.mjs static-quality.mjs unit-reporter.mjs release-routes.mjs nightly-sites.mjs; do
  install -m 700 "$(dirname "$0")/$src" "$runtime/$src.new"
  mv "$runtime/$src.new" "$runtime/$src"
done
launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
rm -f "$plist"
plutil -create xml1 "$plist"
plutil -insert Label -string "$label" "$plist"
plutil -insert ProgramArguments -array "$plist"
plutil -insert ProgramArguments.0 -string "$node_bin" "$plist"
plutil -insert ProgramArguments.1 -string "$runtime/release-pilot.mjs" "$plist"
plutil -insert ProgramArguments.2 -string reconcile "$plist"
plutil -insert EnvironmentVariables -dictionary "$plist"
plutil -insert EnvironmentVariables.PATH -string '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' "$plist"
plutil -insert RunAtLoad -bool true "$plist"
plutil -insert StartInterval -integer 30 "$plist"
plutil -insert StandardErrorPath -string "$HOME/Library/Logs/JAM-Bot/release-pilot.log" "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
