import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {deploymentJobs} from '../src/management-jobs.js';
import {Journal} from '../src/intake-journal.js';
import {targetFields} from '../src/management-contract.js';

test('deployment receipt is durable and retries never launch twice',async t=>{
  const journal=new Journal(':memory:');t.after(()=>journal.db.close());
  const routes=new Map([['1/2',{state:'/tmp',topic:{cwd:'/tmp/leo',repository:'o/r',installation:1,repoId:2},journal}]]);
  let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});
  let calls=0;
  const active=new Set<Promise<void>>();
  const ops=deploymentJobs(routes,{name:'environment_deploy',description:'test',mutate:true,
    input:z.strictObject({...targetFields,environment:z.string(),revision:z.string()}),output:z.strictObject({}),
    run:async({revision})=>{calls++;await wait;return {revision,healthy:true};}},active);
  const args={serverId:randomUUID(),repoId:2,requestId:randomUUID(),revision:'a'.repeat(40),environment:'staging'};
  const start=ops[0]!,status=ops[1]!;
  assert.equal((await start.run(args)).state,'running');
  assert.equal((await start.run(args)).state,'running');assert.equal(calls,1);
  await assert.rejects(start.run({...args,revision:'b'.repeat(40)}),/different deployment/);
  await assert.rejects(start.run({...args,requestId:randomUUID()}),/already running/);
  release();await Promise.all(active);
  assert.equal((await status.run(args)).state,'succeeded');
  assert.equal((await start.run(args)).state,'succeeded');assert.equal(calls,1);
});
