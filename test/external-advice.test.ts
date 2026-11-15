import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {adviserNotes,externalReview,reviewPacket} from '../src/external-advice.js';
import type {TaskApproval} from '../src/task-approval.js';
import type {Topic} from '../src/intake-journal.js';
import type {exchange} from '../src/profile-checkout.js';

const topic:Topic={repoId:21,repository:'example/project',installation:42,cwd:'/unused'};
const approval:TaskApproval={actor:{id:1,type:'User',login:'someone'},author:{id:1,type:'User',login:'someone'},title:'Approved title',body:'Approved requirement',typeId:12};
test('bounded evidence identifies omitted material and retains exact short values',()=>{
  const full='漢字"\n'.repeat(30000);
  const packet=reviewPacket({diff:full,issue:'7',test:'first\nsecond'},4096);
  assert.ok(Buffer.byteLength(packet)<=4096);
  assert.equal(JSON.parse(packet).test,'first\nsecond');
  assert.match(JSON.parse(packet).diff,/SHA-256 [0-9a-f]{64}/);
});
test('each original work card retains attributable adviser results and identical evidence reuses completed reviews',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-external-advice-'));
  const seen:number[]=[];
  let calls=0;
  const broker:typeof exchange=async (_dir,request)=>{
    calls++;assert.equal(request.phase,'diagnosis');assert.deepEqual(request.cards?.map(c=>c.issue),[2,3]);
    assert.equal(JSON.parse(request.packet!).revision,'abcd');
    return {sha:'',advice:[{name:'primary',provider:'codex',status:'ok',text:'Check the test expectation.'},
      {name:'other',provider:'antigravity',status:'unavailable',text:'Not signed in'}]};
  };
  const cards=[{issue:2,approval},{issue:3,approval}];
  try{
    const run=()=>externalReview(dir,topic,cards,'diagnosis',{revision:'abcd'},new AbortController().signal,broker,async (_,issue)=>{seen.push(issue);});
    const first=await run();assert.equal((await run()).inputDigest,first.inputDigest);
    assert.equal(calls,1);assert.deepEqual(seen,[2,3,2,3]);assert.match(adviserNotes(first),/Check the test/);
    assert.doesNotMatch(adviserNotes(first),/Not signed in/);
    for(const card of cards){
      const record=JSON.parse(await readFile(join(dir,'assignments',String(card.issue),'consultations','diagnosis.json'),'utf8'));
      assert.equal(record.inputDigest,first.inputDigest);assert.equal(record.advice[1].status,'unavailable');
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
