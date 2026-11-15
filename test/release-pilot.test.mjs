import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalText,verifyApproval,checkedSite} from '../scripts/macos/release-pilot.mjs';

const sha='a'.repeat(40);
const human={id:19,type:'User',login:'owner'};
const time=new Date(3000).toISOString();
const evidence={sha,issue:24,acceptedAt:1000,readyAt:2000,now:4000,
  comment:{body:approvalText(sha),issue_url:'https://api.github.com/repos/alexmakeev/jam-bot-test/issues/24',
    created_at:time,updated_at:time,user:human},
  repository:{id:1457276291,owner:human},permission:{role_name:'admin',user:human}};

test('stable binds current human authority, original issue, immutable approval, window and exact build',()=>{
  verifyApproval(evidence);
  verifyApproval({...evidence,repository:{...evidence.repository,owner:{type:'Organization'}},permission:{user:human,role_name:'maintain'}});
  for(const change of [
    {sha:'b'.repeat(40)}, {issue:25}, {now:1200}, {readyAt:3500},
    {comment:{...evidence.comment,updated_at:new Date(3100).toISOString()}},
    {comment:{...evidence.comment,performed_via_github_app:{id:1}}},
    {comment:{...evidence.comment,user:{...human,type:'Bot'}}},
    {permission:{...evidence.permission,user:{...human,id:23}}},
    {permission:{...evidence.permission,role_name:'write'}},
    {repository:{...evidence.repository,owner:{type:'User',id:23}}}
  ])assert.throws(()=>verifyApproval({...evidence,...change}));
});

test('a failed browser gate restores the prior verified image even after process restart',async()=>{
  const destination={name:'calculator-rc',port:19857},endpoint={address:'127.0.0.1',port:19857};
  const job={revision:sha,image:'candidate'},old={revision:'b'.repeat(40),image:'previous'};
  const rc={previous:{'calculator-rc':old}};let site={...job,running:true,healthy:true,endpoint};const deployed=[];
  const call=async(_project,_destination,action,revision)=>{
    if(action==='get')return {tier:'staging',settings:{endpoint,secretRefs:[]}};
    if(action==='status')return site;
    assert.equal(action,'deploy');deployed.push(revision);site={...old,running:true,healthy:true,endpoint};return site;
  };
  await assert.rejects(checkedSite({},destination,job,rc,()=>assert.fail(),call,async()=>{throw Error('browser failure');}),/browser failure/);
  assert.deepEqual(deployed,[old.revision]);assert.equal(site.image,'previous');
});
