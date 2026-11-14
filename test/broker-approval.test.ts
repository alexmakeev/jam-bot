import assert from 'node:assert/strict';
import test from 'node:test';
import {brokerFiles} from '../src/broker-approval.js';
import type {TaskApproval} from '../src/task-approval.js';

test('publisher independently verifies Task scope, separate contributing humans and current permissions',async()=>{
  const author={id:1,login:'reporter',type:'User'};
  const actor={id:2,login:'maintainer',type:'User'};
  const approval:TaskApproval={actor,author,title:'Add sum',body:'Files: src/sum.ts\n\nAdd addition.',typeId:8};
  const issue={...approval,number:7,user:author,state:'open',locked:true,type:{name:'Task',id:8},labels:[]};
  const ids:string[]=[];
  const access=async(login:string)=>{ids.push(login);return {user:login===actor.login?actor:author,permission:'write'};};
  assert.deepEqual(await brokerFiles(7,issue,approval,access),['src/sum.ts']);
  assert.deepEqual(ids,['reporter','maintainer']);
  await assert.rejects(brokerFiles(7,{...issue,type:{name:'Feature',id:8}},approval,access));
  await assert.rejects(brokerFiles(7,{...issue,body:'Files: x.ts'},approval,access));
  await assert.rejects(brokerFiles(7,issue,approval,async login=>({...await access(login),permission:login===actor.login?'read':'write'})));
  await assert.rejects(brokerFiles(7,{...issue,labels:[{name:'class:assignment'}]},approval,access));
});
