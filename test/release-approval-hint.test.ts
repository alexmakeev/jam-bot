import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storeReleaseApprovalHint} from '../src/release-approval-hint.js';

test('release wake-ups carry one immutable commit and deduplicate redelivery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'jam-release-hints-')),repo='alexmakeev/jam-bot-test',sha='c'.repeat(40);
  const comment={id:100,body:'Approve JAM-Bot stable release of '+repo+' at '+sha+'.',user:{type:'User',id:42}};
  try{
    await storeReleaseApprovalHint(root,111,repo,24,comment,19);
    await storeReleaseApprovalHint(root,111,repo,24,{...comment,body:comment.body+' extra'},42);
    assert.deepEqual(await readdir(root),[]);
    await Promise.all([1,2].map(()=>storeReleaseApprovalHint(root,111,repo,24,comment,42)));
    const location=join(root,'release-approvals','111');
    assert.deepEqual(await readdir(location),['100.json']);
    assert.deepEqual(JSON.parse(await readFile(join(location,'100.json'),'utf8')),{repoId:111,issue:24,commentId:100,sha});
  }finally{await rm(root,{recursive:true,force:true});}
});
