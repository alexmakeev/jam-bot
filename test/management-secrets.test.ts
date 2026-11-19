import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {secretOperations} from '../src/management-secrets.js';
import {topicKey,type TopicRuntime} from '../src/topics.js';

const serverId=randomUUID();
const target={serverId,repoId:1,environment:'preview'};
const route={topic:{repoId:1,repository:'owner/test',installation:1,cwd:'/unused'},state:'/unused'} as TopicRuntime;

test('secret operations share environment targeting, keep values out of metadata and validate masked outputs',async()=>{
  const calls:{input:unknown;value:unknown}[]=[];
  const api=secretOperations(new Map([[topicKey(1,1),route]]),serverId,async(input,value)=>{
    calls.push({input,value});
    return input.action==='secret-set'?{alias:input.alias,requestId:input.requestId,updated:true}:
      {secrets:[{alias:'api-key',present:true,masked:'ab****yz'}]};
  });
  const invoke=async(name:string,input:unknown)=>{
    const op=api.find(op=>op.name===name)!;return op.output.parse(await op.run(op.input.parse(input)));
  };
  const canary='ab-CANARY-secret-yz',requestId=randomUUID();
  const written=await invoke('secret_set',{...target,alias:'api-key',value:canary,requestId});
  assert.deepEqual(written,{alias:'api-key',requestId,updated:true});
  assert.equal(JSON.stringify(calls[0]!.input).includes(canary),false);
  assert.equal(calls[0]!.value,canary);
  assert.deepEqual(await invoke('secret_get',target),{secrets:[{alias:'api-key',present:true,masked:'ab****yz'}]});
  await assert.rejects(invoke('secret_set',{...target,alias:'../key',value:canary}));
  await assert.rejects(invoke('secret_get',{...target,repoId:2}),/does not manage/);
  await assert.rejects(invoke('secret_get',{...target,serverId:randomUUID()}),/identity has changed/);
  assert.equal(calls.length,2);
});

test('secret host errors cannot echo submitted values',async()=>{
  const canary='CANARY-never-in-errors';
  const api=secretOperations(new Map([[topicKey(1,1),route]]),serverId,async()=>{throw Error(canary);});
  const op=api.find(op=>op.name==='secret_set')!;
  await assert.rejects(op.run(op.input.parse({...target,alias:'key',value:canary})),error=>{
    assert.equal(String(error).includes(canary),false);return true;
  });
});
