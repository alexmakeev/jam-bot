import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {exchange} from '../src/profile-checkout.js';
import {collectDeploymentProgress,deploymentVerified} from '../src/deployment-progress.js';

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
