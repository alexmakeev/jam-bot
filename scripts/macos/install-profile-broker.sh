#!/bin/bash
set -euo pipefail
umask 077
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 OWNER/REPO IMAGE_FOR_ISOLATED_TESTS [node-strip|typescript-build]" >&2; exit 2
fi
repo=$1
image=$(docker image inspect --format '{{.Id}}' "$2")
recipe=${3:-node-strip}
[[ "$recipe" == node-strip || "$recipe" == typescript-build ]]
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
docker image inspect "$image" >/dev/null
gh api "repos/$repo" --jq '.permissions.push' | grep -qx true
dir="$HOME/Library/Application Support/JAM-Bot/profile-broker"
exchange="$HOME/.jam-bot/profile-exchange"
label=local.jam-bot.profile-broker
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$dir" "$exchange" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/JAM-Bot"
src=$(cd "$(dirname "$0")/../.." && pwd)
(cd "$src" && npm run build)
mkdir -p "$dir/runtime"
printf '%s\n' '{"type":"module"}' > "$dir/runtime/package.json"
install -m 600 "$src/dist/src/profile-card.js" "$src/dist/src/broker-approval.js" "$dir/runtime/"
install -m 700 "$(dirname "$0")/profile-broker.mjs" "$(dirname "$0")/profile-recipes.mjs" "$(dirname "$0")/calculator-deployment.mjs" "$(dirname "$0")/consultants.mjs" "$(dirname "$0")/antigravity-consultant.mjs" "$dir/"
node --input-type=module - "$dir" "$repo" "$image" "$recipe" <<'NODE'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const [dir,repo,image,recipe]=process.argv.slice(2);
const {projectRecipes}=await import(pathToFileURL(dir+'/profile-recipes.mjs'));
const file=dir+'/config.json';
let projects={};
try { projects=projectRecipes(JSON.parse(readFileSync(file,'utf8'))); } catch(error) { if(error.code!=='ENOENT') throw error; }
projects[repo]={...projects[repo],image,recipe};
const tmp=file+'.'+randomUUID()+'.tmp';
writeFileSync(tmp,JSON.stringify({projects},null,2)+'\n',{flag:'wx',mode:0o600});
renameSync(tmp,file);
NODE
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
