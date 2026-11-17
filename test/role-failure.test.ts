import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishRoleFailure,RoleStageFailure} from '../src/role-failure.js';
import {checkpointRole} from '../src/role-checkpoint.js';
import {stageRefused} from '../src/native-teammate.js';

const topic={repository:'owner/repo',repoId:10,installation:11,cwd:'/unused'};

test('refusal detection accepts a complete final row without newline and ignores an in-flight final row',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'refusal-final-row-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'session.jsonl'),at=Date.now();
  const row=JSON.stringify({type:'assistant',sessionId:'lead',isApiErrorMessage:true,message:{stop_reason:'refusal'},timestamp:new Date(at).toISOString()});
  await writeFile(path,row);
  assert.equal(await stageRefused(path,'lead',at),true);
  assert.equal(await stageRefused(path,'another',at),false);
  await writeFile(path,row.slice(0,-5));
  assert.equal(await stageRefused(path,'lead',at),false);
  await writeFile(path,row+'\n'+row.slice(0,-5));
  assert.equal(await stageRefused(path,'lead',at),true);
});

test('a refused role persists its safe category and original local diagnostic and is never resubmitted',async t=>{
  const state=await mkdtemp(join(tmpdir(),'role-refusal-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const job={state,cwd:state,session:'lead',issue:35,role:'architect' as const,input:'original task',signal:new AbortController().signal};
  let calls=0;
  const detail='Native teammate spawn was declined by the harness; private diagnostic token=sample-secret';
  const run=async()=>{calls++;throw Error(detail);};
  for(let i=0;i<2;i++)await assert.rejects(checkpointRole(job,'publish specification',run),error=>{
    assert.ok(error instanceof RoleStageFailure);assert.equal(error.category,'harness_refusal');
    assert.equal(error.localDetail,detail);assert.doesNotMatch(error.message,/sample-secret/);assert.doesNotMatch(JSON.stringify(error),/sample-secret/);return true;
  });
  assert.equal(calls,1);
  const directory=join(state,'assignments','35','roles');
  const files=await readdir(directory);const saved=JSON.parse(await readFile(join(directory,files[0]!),'utf8'));
  assert.equal(saved.failureCategory,'harness_refusal');assert.equal(saved.failureDetail,detail);
});

test('a historical role incident publishes one sanitized role report with responsible mention and survives ambiguous publication',async t=>{
  const state=await mkdtemp(join(tmpdir(),'role-incident-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const records:{identity:string;summary:string;report:unknown}[]=[];let confirms=0;
  const deps={
    profile:async()=>({markdown:'',owner:'owner',revision:'a'.repeat(40),responsibilities:[{area:'architecture',role:'Architect',login:'architect-owner'}]}),
    record:(_state:string,_issue:number,identity:string,summary:string,report:unknown)=>{records.push({identity,summary,report});},
    confirm:async()=>{if(++confirms===1)throw Error('lost response');return 77;},
  };
  const request={state,topic,issue:35,error:Error('Native architect refused or declined architect-35-abcd. token=sample-secret')};
  await assert.rejects(publishRoleFailure(request,deps),/lost response/);
  const result=await publishRoleFailure(request,deps);
  const replay=await publishRoleFailure(request,deps);
  assert.equal(result.commentId,77);assert.deepEqual(replay,result);assert.equal(confirms,2);
  assert.equal(records[0]!.identity,records[1]!.identity);
  assert.match(records[0]!.summary,/❓ @architect-owner/);
  assert.doesNotMatch(JSON.stringify(records),/sample-secret|architect-35-abcd|token=/);
  const markdown=(records[0]!.report as {markdown:string}).markdown;
  assert.match(markdown,/Role: Architect/);assert.match(markdown,/harness_refusal/);
  const directory=join(state,'role-incidents','35');const files=await readdir(directory);
  assert.equal(files.length,1);const saved=JSON.parse(await readFile(join(directory,files[0]!),'utf8'));
  assert.match(saved.detail,/sample-secret/);assert.equal(saved.commentId,77);
});

test('a generic historical stop resolves its producing role from the saved failed checkpoint without dispatch',async t=>{
  const state=await mkdtemp(join(tmpdir(),'historical-role-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const {mkdir}=await import('node:fs/promises');const directory=join(state,'assignments','35','roles');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'architect-previous.json'),JSON.stringify({startedAt:1,failure:'Native architect refused or declined a saved invocation'}));
  let summary='';let report='';
  const result=await publishRoleFailure({state,topic,issue:35,error:Error('An incomplete stage was retained for diagnosis')},{
    profile:async()=>({markdown:'',owner:'owner',revision:'a'.repeat(40),responsibilities:[]}),
    record:(_state,_issue,_identity,value,artifact)=>{summary=value;report=(artifact as {markdown:string}).markdown;},
    confirm:async()=>91,
  });
  assert.equal(result.role,'architect');assert.equal(result.category,'harness_refusal');
  assert.match(summary,/❓ @owner/);assert.match(report,/Role: Architect/);
});
