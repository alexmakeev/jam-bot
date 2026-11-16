#!/bin/bash
# Install the platform-independent runtime under the service operator's account.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
dir="$HOME/.jam-bot/management"
exchange="$HOME/.jam-bot/management-exchange"
node_path=${JAM_HOST_NODE:-$(command -v node)}
"$node_path" -e "require('node:sqlite')" >/dev/null
mkdir -p "$dir/runtime" "$exchange"
chmod 700 "$dir" "$dir/runtime" "$exchange"
"$node_path" --input-type=module - "$dir" <<'JS'
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.argv[2];
function initialize(name,value){
  try {writeFileSync(join(dir,name),value,{mode:0o600,flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;}
}
initialize('owner.token',randomBytes(32).toString('hex')+'\n');
initialize('server-id',randomUUID()+'\n');
const token=readFileSync(join(dir,'owner.token'),'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(token))throw Error('Unexpected owner token format');
const id=readFileSync(join(dir,'server-id'),'utf8').trim();
initialize('catalog.json',JSON.stringify({serverId:id,recipes:[]},null,2)+'\n');
if(JSON.parse(readFileSync(join(dir,'catalog.json'),'utf8')).serverId!==id)throw Error('Host catalog identity changed');
const verifier=join(dir,'.verifier-'+randomUUID());
writeFileSync(verifier,'sha256:'+createHash('sha256').update(token).digest('hex')+'\n',{mode:0o600,flag:'wx'});
renameSync(verifier,join(dir,'owner.sha256'));
JS
(cd "$root" && npm run build)
install -m 600 "$root/dist/src/environment-wire.js" "$dir/runtime/environment-wire.js"
install -m 600 "$root/scripts/macos/management-task-host.mjs" "$dir/runtime/management-task-host.mjs"
install -m 600 "$root/scripts/macos/environment-host.mjs" "$dir/runtime/environment-host.mjs"
install -m 600 "$root/scripts/macos/s3-release.mjs" "$root/scripts/macos/s3-artifact.mjs" "$dir/runtime/"
mkdir -p "$dir/runtime/node_modules/aws4"
install -m 600 "$root"/node_modules/aws4/{aws4.js,lru.js,package.json} "$dir/runtime/node_modules/aws4/"
printf '%s\n' '{"type":"module"}' > "$dir/runtime/package.json"
