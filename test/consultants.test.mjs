import test from 'node:test';
import assert from 'node:assert/strict';
import {consultAll,consultantProfiles,selectedConsultants} from '../scripts/macos/consultants.mjs';
const profile={name:'Codex',provider:'codex',image:'sha256:'+'1'.repeat(64),volume:'jam-codex-consultant-home'};
const packet=JSON.stringify({role:'architect',task:'Review idempotency'});
test('optional operator profiles are called concurrently and all receipts are returned',async()=>{
  assert.deepEqual(await consultAll([], 'architecture',packet),{advice:[]});
  const profiles=[profile,{...profile,name:'Second',provider:'antigravity',volume:'jam-antigravity-home'}];
  let signalFirst,secondStarted=false;
  const result=consultAll(profiles,'implementation',packet,{
    codex:async args=>{assert.equal(args.packet,packet);await new Promise(resolve=>{signalFirst=resolve;});return 'Use one transaction';},
    antigravity:async()=>{secondStarted=true;throw Object.assign(Error('private diagnostics'),{unavailable:true});}
  });
  assert.equal(secondStarted,true);signalFirst();
  const {advice}=await result;
  assert.deepEqual(advice.map(a=>[a.name,a.status]),[['Codex','ok'],['Second','unavailable']]);
  assert.ok(!JSON.stringify(advice).includes('private diagnostics'));
});
test('runtime and profiles are constrained by the operator catalog',async()=>{
  assert.throws(()=>consultantProfiles([profile,{...profile}]));
  for(const field of [{image:'latest'},{volume:'/host'},{provider:'shell'},{timeoutMinutes:40},{model:'--danger'}]){
    assert.throws(()=>consultantProfiles([{...profile,...field}]));
  }
  await assert.rejects(consultAll([profile],'diagnosis','not json'));
});

test('retries are limited to existing named subscriptions and transient failures',async()=>{
  assert.throws(()=>selectedConsultants([profile],['unknown']));
  assert.throws(()=>selectedConsultants([profile],[]));
  assert.deepEqual(selectedConsultants([profile],['Codex']),[profile]);
  let attempts=0;
  const {advice}=await consultAll([profile],'diagnosis',packet,{codex:async()=>{
    attempts++;if(attempts===1)throw Object.assign(Error('retry'),{transient:true});return 'Use the failing seed';
  }});
  assert.equal(attempts,2);assert.equal(advice[0].status,'ok');
});
