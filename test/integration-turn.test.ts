import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {BranchValidation} from '../src/branch-validation.js';
import {IntegrationLaneYield, NativeLaneYield, prefillDevelopmentTasks, runDeveloperProfile} from '../src/developer-profile.js';
import {Journal, type Topic} from '../src/intake-journal.js';
import {IntegrationQueue} from '../src/integration-queue.js';
import {git} from '../src/profile-checkout.js';

test('a reviewed architecture yields before publication and resumes ahead of fresh intake', async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-integration-turn-'));
  const journalPath=join(state,'intake.sqlite');
  const repository='fixture/project';
  const topic:Topic={repository,repoId:1,installation:2,cwd:join(state,'leo')};
  let journal=new Journal(journalPath);
  journal.start(topic);
  t.after(async()=>{journal.db.close();await rm(state,{recursive:true,force:true});});
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const key=join(state,'app.pem');
  await writeFile(key,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const environment={JAM_GITHUB_APP_ID:'1',JAM_GITHUB_APP_KEY_FILE:key,JAM_DEVELOPMENT_V2_REPOSITORIES:repository};
  for(const [name,value] of Object.entries(environment)){
    const previous=process.env[name];
    process.env[name]=value;
    t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});
  }
  const api=t.mock.method(globalThis,'fetch',async (url:RequestInfo|URL)=>{
    if(String(url).endsWith('/access_tokens'))return Response.json({token:'fixture'});
    if(String(url).endsWith('/issues/2/labels?per_page=100'))return Response.json([{name:'status:planning'}]);
    throw Error('Unexpected GitHub interaction: '+String(url));
  });
  const store=join(state,'project.git'), tree=join(state,'worktrees','2');
  const authoring=join(state,'baseline');
  await mkdir(authoring);
  await git(authoring,'init','-b','dev');
  await writeFile(join(authoring,'base.ts'),'export const value = 1;\n');
  await git(authoring,'add','base.ts');
  await git(authoring,'-c','commit.gpgsign=false','commit','-m','Baseline');
  const base=await git(authoring,'rev-parse','HEAD');
  await git(state,'clone','--bare',authoring,store);
  await mkdir(join(state,'worktrees'));
  await git(store,'worktree','add','-b','jam/issue-2',tree,base);
  const directory=join(state,'assignments','2');
  const handoff={output:'Implement the approved result.'};
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'architect.json'),JSON.stringify(handoff));
  const insert=journal.db.prepare("INSERT INTO intake(delivery,issue,action,title,body,state,workerState) VALUES(?,?,'task','fixture','','received','pending')");
  insert.run('older',1);
  insert.run('completed-architecture',2);
  journal.enqueue({delivery:'fresh-intake',issue:3,title:'Fresh intake',body:'',action:'task'});
  assert.equal(journal.nextWorker(task=>task.issue===2,()=>true)?.issue,2);
  const checkpoint=JSON.stringify({store,tree,branch:'jam/issue-2',base,expected:base});
  journal.checkpointSpecification(2,checkpoint);
  const validator=new BranchValidation(journal.db), queue=new IntegrationQueue(journal.db);
  const head={issue:4,branch:'jam/issue-4',sha:'4'.repeat(40)};
  const signal=AbortSignal.timeout(60000);
  validator.submit(head,1000);
  validator.tick(queue,async()=>{},signal);
  await validator.settle();

  const actor={id:1,login:'fixture',type:'User' as const};
  const profile={topic,state,lead:journal.lead().id,issue:2,signal,authorize:async()=>{},
    approval:{actor,author:actor,typeId:1,title:'Fixture',body:'Approved outcome'},
    card:{kind:'development' as const,task:'Approved outcome',files:['feature.ts','test/feature.test.ts']},
    adviceLane:{beforeNative:async()=>{throw Error('Unexpected native dispatch');},submitted:()=>{throw Error('Unexpected adviser dispatch');}}};
  await assert.rejects(runDeveloperProfile({...profile,beforeSpecification:()=>{
    assert.deepEqual(queue.snapshot().ready,[head]);
    throw new IntegrationLaneYield();
  }}), IntegrationLaneYield);
  assert.equal(journal.specificationCheckpoint(2),checkpoint);
  assert.equal(existsSync(join(directory,'attachments')),false);
  journal.parkWorkerForIntegration('completed-architecture');
  assert.equal(prefillDevelopmentTasks(topic,journal),false);
  const batch=validator.tick(queue,async()=>{},signal).batch;
  assert.deepEqual(batch?.entries,[head]);

  journal.db.close();
  journal=new Journal(journalPath);
  journal.start(topic);
  const recoveredQueue=new IntegrationQueue(journal.db);
  assert.deepEqual(recoveredQueue.active(),batch);
  recoveredQueue.finish(batch!.id,'integrated');
  assert.equal(prefillDevelopmentTasks(topic,journal),false);
  assert.deepEqual(journal.pendingWorkers().map(task=>task.issue),[2,1]);
  assert.equal(journal.nextWorker()?.issue,2);
  const stopBeforePublication=new NativeLaneYield('Fixture stops before external publication');
  await assert.rejects(runDeveloperProfile({...profile,beforeSpecification:()=>{
    assert.deepEqual(recoveredQueue.snapshot(),{active:undefined,ready:[]});
    throw stopBeforePublication;
  }}),error=>error===stopBeforePublication);
  assert.equal(journal.specificationCheckpoint(2),checkpoint);
  assert.equal(api.mock.calls.length,4);
  assert.equal(existsSync(join(directory,'attachments')),false);
});

test('a withdrawn or dependency-held integration continuation releases priority',()=>{
  const journal=new Journal(':memory:');
  try{
    const insert=journal.db.prepare("INSERT INTO intake(delivery,issue,action,title,body,state,workerState) VALUES(?,?,'task','fixture','','received','pending')");
    insert.run('earlier',1);insert.run('later',2);
    assert.equal(journal.nextWorker(task=>task.issue===2,()=>true)?.issue,2);
    journal.checkpointSpecification(2,'{}');
    journal.parkWorkerForIntegration('later');
    assert.equal(journal.hasIntegrationContinuation(),true);
    journal.waitForDependencies('later','Dependency: awaiting verified integration');
    assert.equal(journal.hasIntegrationContinuation(),false);
    assert.equal(journal.nextWorker()?.issue,1);
    journal.finishWorker('earlier');
    assert.equal(journal.nextWorker()?.issue,2);
    journal.parkWorkerForIntegration('later');
    journal.withdrawPendingWorker('later');
    assert.equal(journal.hasIntegrationContinuation(),false);
    assert.equal(journal.nextWorker(),undefined);
  }finally{journal.db.close();}
});
