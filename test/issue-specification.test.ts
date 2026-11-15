import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishIssueSpec} from '../src/issue-specification.js';

function github() {
  const repo='example/test', issue=7,bot=23;
  let artifact:any,comment:any,posts=0,failResponse=true,alterRead=false;
  const api=async(path:string,method='GET',raw?:object)=>{
    if(!path)return {id:51};
    if(path.startsWith('/issues/7/artifacts?'))return artifact?[artifact]:[];
    if(path.startsWith('/issues/7/comments?'))return comment?[comment]:[];
    if(path==='/issues/7/artifacts/1')return {artifact:{...artifact,body:alterRead?artifact.body.trimEnd():artifact.body},versions:[]};
    if(path==='/issues/comments/99')return comment;
    if(method==='POST'){
      posts++;
      if(path==='/issues/7/artifacts'){
        artifact={...raw,id:2,number:1,creator:{id:bot},html_url:'https://github.com/'+repo+'/issues/7/artifacts/1'};
        if(failResponse)throw Error('Lost server response');
        return artifact;
      }
      if(path==='/issues/7/comments'){
        comment={...raw,id:99,user:{id:bot},issue_url:'https://api.github.com/repos/'+repo+'/issues/7'};
        if(failResponse)throw Error('Lost server response');
        return comment;
      }
    }
    throw Error('Unknown path');
  };
  return {repo,issue,bot,api,posts:()=>posts,setAlterRead:()=>{alterRead=true;failResponse=false;}};
}
test('publisher reconciles lost create responses and re-verifies exact Markdown bytes including trailing newlines',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jam-spec-'));
  try{
    const g=github(),markdown='# Specification\n\nA non-ASCII value: café.\r\n\n';
    const run=()=>publishIssueSpec(dir,g.repo,51,g.issue,markdown,g.bot,g.api,async()=>{},new AbortController().signal);
    const receipt=await run();
    assert.equal(receipt.commentId,99);
    assert.deepEqual(await run(),receipt);
    assert.equal(g.posts(),2);
    g.setAlterRead();
    await assert.rejects(run(),/byte.*verification/);
    assert.equal(g.posts(),2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
