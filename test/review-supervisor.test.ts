import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mandatoryReview,type MandatoryReview} from '../src/review-supervisor.js';
import {prepareReviewNotices,queueReviewNotice,publishReviewNotice} from '../src/review-escalation.js';

const answer={developer:'member',nativeMember:'reviewer@team',backend:'in-process',team:'team',output:'PASS\nChecked.'};
const noop=async()=>{};
async function project(t:import('node:test').TestContext):Promise<MandatoryReview>{
  const state=await mkdtemp(join(tmpdir(),'jam-review-'));t.after(()=>rm(state,{recursive:true,force:true}));
  return {state,cwd:state,session:'lead',issue:21,issues:[21],revision:'a'.repeat(40),role:'consultant',input:'immutable original',signal:new AbortController().signal};
}
test('late original receipt completes a timed-out review without a second reviewer',async t=>{
  const job=await project(t);let calls=0;
  const value=await mandatoryReview(job,noop,{run:async()=>{calls++;throw Error('Native teammate receipt timed out');},
    observe:async()=>({receipt:answer}),graceMs:0,pause:noop});
  assert.equal(value.output,answer.output);assert.equal(calls,1);
});
test('retry only the missing review once, retain the input, and replay the verified receipt',async t=>{
  const job=await project(t);let calls=0;const challenges=new Set();
  const deps={run:async (request:{input:string},identity?:string)=>{
    assert.equal(request.input,job.input);challenges.add(identity);
    if(++calls===1)throw Error('Native teammate runtime exited before verified receipt');return answer;
  },observe:async()=>({}),graceMs:0,pause:noop};
  assert.equal((await mandatoryReview(job,noop,deps)).output,answer.output);
  assert.equal((await mandatoryReview({...job,input:'changed ephemeral report'},noop,deps)).output,answer.output);
  assert.equal(calls,2);assert.equal(challenges.size,2);
});
test('explicit safety refusal persists across restart and never resubmits the payload',async t=>{
  const job=await project(t);let calls=0,alerts=0;
  const deps={run:async()=>{calls++;throw Error('Native model refused this stage; preserve the candidate and reconcile before further work');},observe:async()=>({}),graceMs:0,pause:noop};
  for(let i=0;i<2;i++)await assert.rejects(mandatoryReview(job,async()=>{alerts++;},deps),/refused/);
  assert.equal(calls,1);assert.equal(alerts,2);
});
test('restart reconciles an interrupted attempt and escalates unresolved ownership without starting another',async t=>{
  const job=await project(t),stop=new AbortController();let calls=0;
  await assert.rejects(mandatoryReview({...job,signal:stop.signal},noop,{run:async()=>{calls++;stop.abort();throw Error('interrupted');},observe:async()=>({}),graceMs:0,pause:noop}));
  await assert.rejects(mandatoryReview(job,noop,{run:async()=>{calls++;return answer;},observe:async()=>({live:true}),graceMs:0,pause:noop}),/still be active/);
  assert.equal(calls,1);
});
test('authenticated issue notice survives ambiguous creation, pagination and spoofed markers',async()=>{
  const db=new DatabaseSync(':memory:');prepareReviewNotices(db);
  const revision='b'.repeat(40);queueReviewNotice(db,21,revision,'consultant','Model refused');queueReviewNotice(db,21,revision,'consultant','Model refused');
  const row=db.prepare('select * from review_escalations').get()!;
  const notice={issue:21,revision,role:'consultant' as const,reason:'Model refused',diagnosis:'Please revise the scope.',challenge:null,remote:null,attempts:0};
  assert.equal(row.issue,21);assert.equal(db.prepare('select count(*) as n from review_escalations').get()?.n,1);db.close();
  const marker='<!-- jam-bot:mandatory-review:consultant:'+revision+' -->';
  const history:{id:number;body:string;user:{id:number}}[]=Array.from({length:100},(_,i)=>({id:i+1,body:marker,user:{id:2}}));let posts=0;
  const api=async(path:string,method?:string,body?:object)=>{
    if(method==='POST'){posts++;history.push({id:200,body:(body as {body:string}).body,user:{id:42}});throw Error('Connection lost after create');}
    const page=Number(new URL('https://test'+path).searchParams.get('page'));return history.slice(100*(page-1),100*page);
  };
  await assert.rejects(publishReviewNotice(api,42,notice,'owner'));
  assert.equal(await publishReviewNotice(api,42,notice,'owner'),200);
  assert.equal(posts,1);assert.match(history.at(-1)!.body,/@owner.*required PASS is missing/);
});

test('an explicit evidence correction gets a fresh review of the same code revision and replays once',async t=>{
  const job=await project(t);let calls=0;
  const deps={run:async()=>{calls++;return {...answer,output:calls===1?'FAIL\nMissing test metadata.':'PASS\nEvidence complete.'};},observe:async()=>({}),graceMs:0,pause:noop};
  assert.match((await mandatoryReview(job,noop,deps)).output,/^FAIL/);
  const corrected={...job,input:'same code with complete test metadata',evidenceRound:1};
  assert.match((await mandatoryReview(corrected,noop,deps)).output,/^PASS/);
  assert.match((await mandatoryReview(corrected,noop,deps)).output,/^PASS/);
  assert.equal(calls,2);
});
