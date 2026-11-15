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
