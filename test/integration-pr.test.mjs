import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareIntegrationPr,verifyIntegrationPr} from '../scripts/macos/integration-pr.mjs';
const revision='a'.repeat(40);
const record={number:7,head:{sha:revision},base:{ref:'dev',repo:{full_name:'o/r'}},state:'open'};
test('recovery reuses the existing immutable branch and PR without another write',async()=>{
  const writes=[];
  const pr=await prepareIntegrationPr({repo:'o/r',revision,expected:'b'.repeat(40),cards:[{issue:1}],
    git:async args=>{assert.equal(args[0],'ls-remote');return revision+'\trefs/heads/jam/integration-'+revision;},
    api:async(path,method)=>{if(method)writes.push(method);return [record];}});
  assert.equal(pr.number,7);assert.deepEqual(writes,[]);
});
test('closure evidence requires an actually merged PR for the exact candidate',async()=>{
  await assert.rejects(verifyIntegrationPr('o/r',7,revision,async()=>({...record,merged:false})),/reconciliation/);
  await assert.rejects(verifyIntegrationPr('o/r',7,revision,async()=>({...record,merged:true,head:{sha:'c'.repeat(40)}})),/reconciliation/);
  assert.equal((await verifyIntegrationPr('o/r',7,revision,async()=>({...record,merged:true,html_url:'https://example.test/pr'}))).sha,revision);
});
