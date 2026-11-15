import test from 'node:test';
import assert from 'node:assert/strict';
import {antigravityArgs,consultAntigravity} from '../scripts/macos/antigravity-consultant.mjs';
const profile={volume:'jam-antigravity-home',image:'sha256:'+'1'.repeat(64)};
test('isolated consultant pins the image, mounts only its own volume and denies model-invoked tools',()=>{
 const args=antigravityArgs(profile,'test');
 assert.deepEqual(args.filter(a=>a.includes('type=volume')),['type=volume,src=jam-antigravity-home,dst=/home/jam']);
 assert.equal(args[args.indexOf('--network')+1],'jam-antigravity-private');
 assert.equal(args[args.indexOf('--entrypoint')+1],'/usr/local/bin/agy');assert.ok(args.includes(profile.image));
 const settings=JSON.parse(args[args.indexOf('--settings')+1]);
 assert.deepEqual(new Set(settings.permissions.deny),new Set(['read_file(*)','write_file(*)','command(*)','unsandboxed(*)','execute_url(*)','read_url(*)','mcp(*)']));
 for(const changed of [{image:'latest'},{volume:'other'},{model:'--new-project'}])assert.throws(()=>antigravityArgs({...profile,...changed},'test'));
});
test('review input is bounded before accessing the engine',async()=>{
 await assert.rejects(consultAntigravity({profile,packet:'é'.repeat(33000)}),/packet/);
});
