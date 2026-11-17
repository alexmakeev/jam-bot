import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('restarted publisher commits a staged answer and preserves an uncertain adviser claim without a second call',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-host-resume-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const installed=join(dir,'host'),exchange=join(dir,'exchange');
  await mkdir(installed);await mkdir(exchange);
  for(const file of ['profile-broker.mjs','integration-pr.mjs','profile-recipes.mjs','calculator-deployment.mjs','consultants.mjs','antigravity-consultant.mjs'])
    await cp(new URL('../scripts/macos/'+file,import.meta.url),join(installed,file));
  // No new request is executed in this fixture. A second dispatch must fail the test.
  await mkdir(join(installed,'runtime'));
  await writeFile(join(installed,'runtime','package.json'),'{"type":"module"}');
  await writeFile(join(installed,'runtime','project-values-reader.js'),"export function readProjectSource(){throw Error('unexpected profile dispatch')}");
  await writeFile(join(installed,'runtime','broker-approval.js'),"export function brokerFiles(){throw Error('unexpected new dispatch')}");
  await writeFile(join(dir,'config.json'),'{"projects":{}}');
  const ids=['11111111-1111-4111-a111-111111111111','22222222-2222-4222-a222-222222222222'];
  for(const id of ids){
    await mkdir(join(exchange,id));
    await writeFile(join(exchange,id,'request.json'),JSON.stringify({brokerRequestId:id,action:'consult',repo:'o/r'}));
  }
  const answer={ok:true,value:{advice:[]}};
  await writeFile(join(exchange,ids[0],'answer.tmp'),JSON.stringify(answer));
  execFileSync(process.execPath,[join(installed,'profile-broker.mjs'),exchange,join(dir,'config.json')],{timeout:5000});
  assert.deepEqual(JSON.parse(await readFile(join(exchange,ids[0],'answer.json'),'utf8')),answer);
  const uncertain=JSON.parse(await readFile(join(exchange,ids[1],'answer.json'),'utf8'));
  assert.equal(uncertain.uncertain,true);assert.equal(uncertain.ok,false);
});
