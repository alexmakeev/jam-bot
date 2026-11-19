import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {consultationReady,exchange,git,type ConsultationSubmission} from '../src/profile-checkout.js';
import {digestOf} from '../src/specification-upload.js';
import {collectDeploymentProgress,deploymentVerified,verifiedDeploymentIdentity} from '../src/deployment-progress.js';

test('workspace read evidence survives exchange cleanup and cached consultation recovery',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-inspection-recovery-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const root=join(state,'exchange'),repo=join(state,'repo');await mkdir(root);await mkdir(repo);
  await git(repo,'init');await writeFile(join(repo,'code.ts'),'export const value=1;');await git(repo,'add','.');await git(repo,'commit','-m','fixture');const sha=await git(repo,'rev-parse','HEAD');
  const prior=process.env.JAM_PROFILE_EXCHANGE;process.env.JAM_PROFILE_EXCHANGE=root;t.after(()=>{if(prior===undefined)delete process.env.JAM_PROFILE_EXCHANGE;else process.env.JAM_PROFILE_EXCHANGE=prior;});
  const request={action:'consult' as const,phase:'architecture' as const,repo:'fixture/project',sha,packet:'{}',workspace:{index:'{}',documents:{}}};
  const pending=exchange(repo,request,new AbortController().signal);let id:string|undefined;
  for(let i=0;i<100&&!id;i++){id=(await readdir(root)).find(name=>!name.startsWith('.'));if(!id)await delay(10);}
  assert.ok(id);const reader='codex-00000000-0000-4000-8000-000000000001';
  const identity={revision:sha,specifications:digestOf('{}')},adviser={name:'Codex',provider:'codex'};
  await writeFile(join(root,id,'workspace-reads.jsonl'),JSON.stringify({reader,adviser,identity,events:[{identity,operation:'read',root:'repository',path:'code.ts',bytes:21},{identity,operation:'read',root:'specifications',path:'index.json',bytes:2}]})+'\n');
  await writeFile(join(root,id,'answer.json'),JSON.stringify({ok:true,value:{sha,advice:[{...adviser,status:'ok',text:'Verified fixture'}]}}));
  const result=await pending;assert.equal(result.inspection?.readers[0]?.events.length,2);assert.deepEqual(await readdir(root),[]);
  assert.deepEqual(await exchange(repo,request,new AbortController().signal),result);
  const ledgers=await readdir(join(state,'broker-requests'));assert.ok((await readFile(join(state,'broker-requests',ledgers[0]!,'workspace-reads.jsonl'),'utf8')).includes(reader));
});

test('a killed receiver reattaches to the claimed request and reuses the confirmed response',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-exchange-')),root=join(state,'exchange'),repo=join(state,'project.git');
  await mkdir(root);
  t.after(()=>rm(state,{recursive:true,force:true}));
  const env=process.env.JAM_PROFILE_EXCHANGE;
  process.env.JAM_PROFILE_EXCHANGE=root;
  t.after(()=>{if(env===undefined)delete process.env.JAM_PROFILE_EXCHANGE;else process.env.JAM_PROFILE_EXCHANGE=env;});
  const req={action:'consult' as const,phase:'architecture' as const,repo:'o/r',packet:'Test evidence'};
  const child=spawn(process.execPath,['--input-type=module','-e',
    'import {exchange} from '+JSON.stringify(new URL('../src/profile-checkout.js',import.meta.url).href)+';await exchange(process.argv[1],JSON.parse(process.argv[2]),new AbortController().signal);',repo,JSON.stringify(req)],{stdio:'ignore'});
  t.after(()=>child.kill('SIGKILL'));
  let id:string|undefined;
  for(let i=0;i<100 && !id;i++){id=(await readdir(root)).find(name=>!name.startsWith('.'));if(!id)await delay(20);}
  assert.ok(id);
  const dir=join(root,id);
  await rename(join(dir,'request.ready'),join(dir,'request.json'));
  assert.equal(JSON.parse(await readFile(join(dir,'request.json'),'utf8')).brokerRequestId,id);
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  const response={sha:'revision',advice:[]};
  const resumed=exchange(repo,req,new AbortController().signal);
  await delay(75);
  assert.deepEqual((await readdir(root)).filter(name=>!name.startsWith('.')),[id]);
  await writeFile(join(dir,'answer.json'),JSON.stringify({ok:true,value:response}));
  assert.deepEqual(await resumed,response);
  assert.deepEqual(await exchange(repo,{packet:req.packet,repo:req.repo,phase:req.phase,action:req.action},new AbortController().signal),response);
  assert.deepEqual(await readdir(root),[]);
});

test('implementation consultation can yield after submit and resume the same broker request',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-overlap-'));
  t.after(()=>rm(state,{recursive:true,force:true}));
  const root=join(state,'exchange'),repo=join(state,'repo');await mkdir(root);await mkdir(repo);
  const previous=process.env.JAM_PROFILE_EXCHANGE;
  process.env.JAM_PROFILE_EXCHANGE=root;
  t.after(()=>{if(previous===undefined)delete process.env.JAM_PROFILE_EXCHANGE;else process.env.JAM_PROFILE_EXCHANGE=previous;});
  await git(repo,'init');await writeFile(join(repo,'code.ts'),'export const value=1;');await git(repo,'add','.');await git(repo,'commit','-m','fixture');
  const sha=await git(repo,'rev-parse','HEAD');
  const req={action:'consult' as const,phase:'implementation' as const,repo:'demo/project',sha,packet:'{}'};
  let wait:ConsultationSubmission|undefined;
  const signal=new AbortController().signal;
  await assert.rejects(exchange(repo,req,signal,undefined,undefined,(submission,ready)=>{
    assert.equal(ready,false);wait=submission;throw Error('yield the native lane');
  }),/yield the native lane/);
  assert.ok(wait);assert.equal(await consultationReady(state,wait),false);
  assert.deepEqual(await readdir(root),[wait.id]);
  assert.equal(JSON.parse(await readFile(join(root,wait.id,'request.ready'),'utf8')).sha,sha);
  await writeFile(join(root,wait.id,'answer.json'),JSON.stringify({ok:true,value:{sha,advice:[]}}));
  assert.equal(await consultationReady(state,wait),true);
  const resume=()=>exchange(repo,req,signal,undefined,undefined,(submission,ready)=>{assert.deepEqual(submission,wait);assert.equal(ready,true);});
  assert.deepEqual(await resume(),{sha,advice:[]});
  assert.deepEqual(await resume(),{sha,advice:[]});
  assert.deepEqual(await readdir(root),[]);
});

test('only a matching integrated task may announce a healthy host deployment once',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-deploy-progress-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const root=join(state,'exchange'),dir=join(root,'deployments','15'),revision='a'.repeat(40);
  const topic={repository:'owner/test',repoId:15,installation:5,cwd:state};
  const file=join(dir,revision+'.json');
  const site={acceptance:'passed',issues:[3],repoId:15,repository:topic.repository,revision,environment:'sum',image:'sha256:'+'b'.repeat(64),port:19854,verifiedAt:Date.now()};
  await mkdir(dir,{recursive:true});
  await writeFile(file,JSON.stringify(site));
  await collectDeploymentProgress(state,topic,root);
  assert.deepEqual(await readdir(dir),[revision+'.json']);
  await mkdir(join(state,'assignments','3'),{recursive:true});
  await writeFile(join(state,'assignments','3','result.json'),JSON.stringify({issue:3,dev:revision}));
  await collectDeploymentProgress(state,topic,root);
  await writeFile(file,JSON.stringify(site));await collectDeploymentProgress(state,topic,root);
  const db=new DatabaseSync(join(state,'work-progress.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count,1);
  assert.ok(String(db.prepare('SELECT body FROM events').get()!.body).includes(revision));
  db.close();
  assert.ok(await deploymentVerified(state,15,revision,3));
  assert.equal(await verifiedDeploymentIdentity(state,15,revision,3),'deployment:sum:'+revision);
  assert.equal(await deploymentVerified(state,15,revision,99),false);
  assert.deepEqual(await readdir(dir),[]);
});

test('scoped checkout can try again after the operator registers a previously unknown project',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-seed-retry-')),root=join(state,'exchange');
  t.after(()=>rm(state,{recursive:true,force:true}));
  await mkdir(root);
  const env=process.env.JAM_PROFILE_EXCHANGE;process.env.JAM_PROFILE_EXCHANGE=root;
  t.after(()=>{if(env===undefined)delete process.env.JAM_PROFILE_EXCHANGE;else process.env.JAM_PROFILE_EXCHANGE=env;});
  const request={action:'seed' as const,repo:'owner/repo',scope:'issue:3'};
  const ids=[];
  for(let attempt=0;attempt<2;attempt++){
    const reply=exchange(join(state,'project.git'),request,new AbortController().signal);
    let id:string|undefined;
    for(let i=0;i<50&&!id;i++){id=(await readdir(root)).find(n=>!n.startsWith('.'));if(!id)await delay(10);}
    assert.ok(id);ids.push(id);
    await writeFile(join(root,id,'answer.json'),JSON.stringify({ok:false,error:'Repository outside publisher scope'}));
    await assert.rejects(reply,/not configured/);
  }
  assert.equal(ids[0],ids[1]);
});

test('publication observations are fresh after a negative response rather than cached write results',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-publish-observe-')),root=join(state,'exchange');
  t.after(()=>rm(state,{recursive:true,force:true}));await mkdir(root);
  const env=process.env.JAM_PROFILE_EXCHANGE;process.env.JAM_PROFILE_EXCHANGE=root;
  t.after(()=>{if(env===undefined)delete process.env.JAM_PROFILE_EXCHANGE;else process.env.JAM_PROFILE_EXCHANGE=env;});
  const request={action:'publication-status' as const,repo:'owner/repo'};
  const ids:string[]=[];
  for(let attempt=0;attempt<2;attempt++){
    const pending=exchange(join(state,'project.git'),request,new AbortController().signal);
    const rejected=attempt===0?assert.rejects(pending,/reconciliation/):undefined;
    let id:string|undefined;
    for(let i=0;i<50&&!id;i++){id=(await readdir(root)).find(n=>!n.startsWith('.'));if(!id)await delay(10);}
    assert.ok(id);ids.push(id);
    await writeFile(join(root,id,'answer.json'),JSON.stringify(attempt===0?{ok:false,error:'Publication requires reconciliation'}:{ok:true,value:{sha:'a'.repeat(40),alreadyPublished:true}}));
    if(rejected)await rejected;
    else assert.equal((await pending).alreadyPublished,true);
  }
  assert.notEqual(ids[0],ids[1]);assert.deepEqual(await readdir(root),[]);
});
