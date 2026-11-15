import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {git} from '../src/profile-checkout.js';
import {implementationCommit} from '../src/implementation-checkpoint.js';
import {recordProgress,publishProgress} from '../src/work-progress.js';
import {checkpointRole} from '../src/role-checkpoint.js';

const topic={repository:'owner/repo',repoId:10,installation:11,cwd:'/unused'};

test('timeline authenticates the issue and bot, and reconciles an accepted POST with a lost response',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'timeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  recordProgress(dir,6,'one','Architecture handed off.');
  const db=new DatabaseSync(join(dir,'work-progress.sqlite'));
  const body=String(db.prepare('select body from events').get()!.body);
  const issue_url='https://api.github.com/repos/owner/repo/issues/6';
  const rows=[{id:200,user:{id:20},body,issue_url}];
  let posts=0;
  const api=async (path:string,method?:string)=>{
    if(path==='')return {id:topic.repoId};
    if(!method)return rows;
    posts++;rows.push({id:201,user:{id:40},body,issue_url});throw Error('lost response');
  };
  const credentials=async():Promise<[typeof api,number]>=>[api,40];
  await publishProgress(dir,topic,credentials);
  assert.equal(posts,1);
  assert.equal(db.prepare('select status from events').get()!.status,'sending');
  db.exec('update events set retryAt=0');
  recordProgress(dir,6,'one','Architecture handed off.');
  await publishProgress(dir,topic,credentials);
  assert.equal(posts,1);assert.equal(db.prepare('select receipt from events').get()!.receipt,201);
  assert.equal(await publishProgress(dir,topic,credentials),false);db.close();
});

test('SIGKILL after native output resumes from the original receipt without a second native assignment',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stage-kill-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const job={state:dir,cwd:dir,session:'session',issue:4,role:'developer' as const,input:'approved input'};
  const result={developer:'member-id',nativeMember:'developer@team',backend:'in-process',team:'team',output:'approved changes'};
  const script=`import {writeFile} from 'node:fs/promises';import {checkpointRole} from ${JSON.stringify(new URL('../src/role-checkpoint.js',import.meta.url).href)};
    await checkpointRole({...JSON.parse(process.argv[1]),signal:new AbortController().signal},'validation',async (_job,challenge)=>{
      await writeFile(process.argv[2],JSON.stringify({challenge,receipt:JSON.parse(process.argv[3])}));process.kill(process.pid,'SIGKILL');
    })`;
  const evidence=join(dir,'mailbox.json');
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(job),evidence,JSON.stringify(result)]);
  assert.equal(child.signal,'SIGKILL',String(child.stderr));
  let replay=0;
  const resume=()=>checkpointRole({...job,signal:new AbortController().signal},'validation',async()=>{replay++;throw Error('duplicate assignment');},
    async (_,attempt)=>{const actual=JSON.parse(await readFile(evidence,'utf8'));assert.equal(actual.challenge,attempt.challenge);return {receipt:actual.receipt};});
  assert.deepEqual(await resume(),result);assert.deepEqual(await resume(),result);assert.equal(replay,0);
});

test('developer recovers a previously committed tree and never commits it twice',async t=>{
  const state=await mkdtemp(join(tmpdir(),'commit-checkpoint-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const tree=join(state,'repo');await git(state,'init','repo');await writeFile(join(tree,'file'),'old');
  await git(tree,'add','file');await git(tree,'commit','-m','base');
  const path=join(state,'intent.json');let calls=0;
  const run=()=>implementationCommit(tree,path,1,['file'],async()=>{calls++;return JSON.stringify({files:[{path:'file',content:'new'}]});},async()=>{});
  const head=await run();
  const intent=JSON.parse(await readFile(path,'utf8'));delete intent.sha;
  await writeFile(path,JSON.stringify(intent)); // process stopped immediately after Git committed
  assert.equal(await run(),head);assert.equal(calls,1);
  assert.equal(await git(tree,'rev-list','--count','HEAD'),'2');
  await writeFile(join(tree,'file'),'unexpected');await assert.rejects(run,/Unexpected worktree revision/);
});

test('integration resumes after a fast-forward already happened before the next assembly checkpoint',async t=>{
  const {assembleCandidate}=await import('../src/integration-assembly.js');
  const {mkdir}=await import('node:fs/promises');
  const state=await mkdtemp(join(tmpdir(),'integrator-recovery-'));t.after(()=>rm(state,{recursive:true,force:true}));
  await git(state,'init','repo');const repo=join(state,'repo'),dir=join(state,'integration');
  await mkdir(dir);await writeFile(join(repo,'file'),'1');await git(repo,'add','file');await git(repo,'commit','-m','base');
  const base=await git(repo,'rev-parse','HEAD');
  await writeFile(join(repo,'file'),'2');await git(repo,'commit','-am','candidate');
  const head=await git(repo,'rev-parse','HEAD');
  await writeFile(join(dir,'assembly.json'),JSON.stringify({base,expected:base,heads:[head],current:base,index:0}));
  await git(repo,'worktree','add','--detach',join(dir,'worktree'),head);
  const saved=await assembleCandidate(repo,dir,{sha:base,dev:base},[head]);
  assert.deepEqual(saved,{sha:head,base,expected:base});
  assert.deepEqual(await assembleCandidate(repo,dir,{sha:base,dev:base},[head]),saved);
});
