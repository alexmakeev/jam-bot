import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {queueCalculator,verifiedSite,calculatorRepo} from '../scripts/macos/calculator-deployment.mjs';

test('queue exists only for the opted-in Test publication; duplicate delivery preserves the receipt',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-deploy-test-'));t.after(()=>rm(dir,{force:true,recursive:true}));
  const req={repo:calculatorRepo,action:'publish',sha:'1'.repeat(40),expected:'2'.repeat(40)};
  const opted={autoDeployCalculator:true};
  await queueCalculator({},req,dir);
  await queueCalculator(opted,{...req,action:'test'},dir);
  await queueCalculator(opted,{...req,repo:'alexmakeev/jam-bot-sandbox'},dir);
  assert.deepEqual(await readdir(dir),[]);
  await assert.rejects(queueCalculator(opted,{...req,sha:'../escape'},dir));
  await queueCalculator(opted,req,dir);
  const path=join(dir,req.sha+'.json'),body=JSON.parse(await readFile(path,'utf8'));
  assert.equal(body.revision,req.sha);assert.equal(body.base,req.expected);
  body.done='deployed';await writeFile(path,JSON.stringify(body));
  await queueCalculator(opted,req,dir);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),body);
});
test('receipt proves exact SHA, image, local endpoint and healthy running container',()=>{
  const site={running:true,healthy:true,revision:'abc',image:'pinned',endpoint:{address:'127.0.0.1',port:19853}};
  assert.ok(verifiedSite(site,'abc','pinned'));
  for(const patch of [{running:false},{healthy:false},{revision:'old'},{image:'different'},{endpoint:{port:123}}]){
    assert.equal(verifiedSite({...site,...patch},'abc','pinned'),false);
  }
});

test('failed deployment retries the same built image and reconciles an already healthy deployment',async t=>{
  const {reconcileCalculator}=await import('../scripts/macos/calculator-deployment.mjs');
  const queue=await mkdtemp(join(tmpdir(),'jam-deploy-retry-'));t.after(()=>rm(queue,{force:true,recursive:true}));
  const req={repo:calculatorRepo,action:'publish',sha:'a'.repeat(40),expected:'b'.repeat(40)};
  const project={autoDeployCalculator:true},image='sha256:'+'1'.repeat(64);
  const endpoint={address:'127.0.0.1',port:19853},calls=[];
  let healthy=false;
  const options={queue,registry:join(queue,'registry.json'),repositoryId:async()=>1457276291,
    remoteHead:async()=>req.sha,build:async()=>{calls.push('build');return image;},
    managementCall:async(_project,op)=>{
      calls.push(op);
      if(op==='get')return {tier:'development',settings:{secretRefs:[],endpoint}};
      if(op==='deploy'){healthy=true;throw Error('Simulated lost response after healthy deployment');}
      return {healthy,running:true,image,revision:req.sha,endpoint};
    }};
  await queueCalculator(project,req,queue);
  await reconcileCalculator(project,options);
  const file=join(queue,req.sha+'.json');
  const job=JSON.parse(await readFile(file,'utf8'));
  assert.equal(job.attempts,1);assert.equal(job.image,image);assert.equal(job.done,undefined);
  await writeFile(file,JSON.stringify({...job,after:0}));
  await reconcileCalculator(project,options);
  assert.equal(JSON.parse(await readFile(file,'utf8')).done,'deployed');
  assert.deepEqual(calls,['get','status','build','deploy','get','status']);
});

test('Sandbox publication uses its own repo identity, opt-in and development queue',async t=>{
  const {queueSandbox,sandboxRepo}=await import('../scripts/macos/calculator-deployment.mjs');
  const dir=await mkdtemp(join(tmpdir(),'jam-sandbox-queue-'));t.after(()=>rm(dir,{force:true,recursive:true}));
  const req={action:'publish',repo:sandboxRepo,expected:'a'.repeat(40),sha:'b'.repeat(40)};
  await queueSandbox({autoDeployCalculator:true},req,dir);
  await queueSandbox({autoDeploySum:true},{...req,repo:calculatorRepo},dir);
  assert.deepEqual(await readdir(dir),[]);
  await queueSandbox({autoDeploySum:true},req,dir);
  assert.equal(JSON.parse(await readFile(join(dir,req.sha+'.json'),'utf8')).base,req.expected);
});

test('deployed browser assertion failure restores the previous healthy site and emits a failed closure gate',async t=>{
  const {reconcileCalculator}=await import('../scripts/macos/calculator-deployment.mjs');
  const queue=await mkdtemp(join(tmpdir(),'jam-live-gate-'));t.after(()=>rm(queue,{force:true,recursive:true}));
  const old='a'.repeat(40),revision='b'.repeat(40),oldImage='sha256:'+'1'.repeat(64),image='sha256:'+'2'.repeat(64);
  const project={autoDeployCalculator:true,calculatorSpecCards:{staticSvg:24}};
  await queueCalculator(project,{repo:calculatorRepo,action:'publish',sha:revision,expected:old,cards:[{issue:24}]},queue);
  const endpoint={address:'127.0.0.1',port:19853};
  let current=old;const calls=[];
  const opts={queue,exchange:join(queue,'exchange'),registry:join(queue,'registry.json'),remoteHead:async()=>revision,repositoryId:async()=>1457276291,build:async()=>image,
    managementCall:async(_,op,target)=>{
      if(op==='get')return {tier:'development',settings:{secretRefs:[],endpoint}};
      if(op==='deploy'){current=target;calls.push(target);}
      return {healthy:true,running:true,image:current===old?oldImage:image,revision:current,endpoint};
    },accept:async()=>{throw Error('AssertionError: clipped figure');}};
  await reconcileCalculator(project,opts);await reconcileCalculator(project,opts);
  assert.deepEqual(calls,[revision,old]);
  const result=JSON.parse(await readFile(join(queue,revision+'.json'),'utf8'));
  assert.equal(result.done,'failed-acceptance');
  const notice=JSON.parse(await readFile(join(opts.exchange,'deployments','1457276291',revision+'.json'),'utf8'));
  assert.equal(notice.acceptance,'failed');assert.deepEqual(notice.issues,[24]);
});
