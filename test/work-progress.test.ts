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

test('source reconciliation ignores a forged marker and holds a missing or unrecognized authenticated handoff',async t=>{
  const {reconcileProgress}=await import('../src/work-progress.js');
  const dir=await mkdtemp(join(tmpdir(),'source-progress-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  recordProgress(dir,6,'handoff','Architecture delivered.');
  const db=new DatabaseSync(join(dir,'work-progress.sqlite'));t.after(()=>db.close());
  const row=db.prepare('select body from events').get()!;
  const comment={id:22,user:{id:19},body:String(row.body),issue_url:'https://api.github.com/repos/owner/repo/issues/6'};
  const comments=[comment];
  const api=async(path:string)=>path===''?{id:10}:comments;
  const creds=async():Promise<[typeof api,number]>=>[api,19];
  await reconcileProgress(dir,topic,6,creds);
  assert.equal(db.prepare('select receipt from events').get()!.receipt,22);
  comment.user.id=18;
  await assert.rejects(reconcileProgress(dir,topic,6,creds),/missing/);
  comment.user.id=19;comment.body='another outcome'+comment.body.slice(comment.body.indexOf('\n'));
  await assert.rejects(reconcileProgress(dir,topic,6,creds),/disagree/);
});

test('one authenticated result gains multiple late Markdown files in-place and reconciles a lost edit reply',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'late-reports-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(join(dir,'work-progress.sqlite'));t.after(()=>db.close());
  const comments:{id:number;issue_url:string;user:{id:number};body:string}[]=[];
  const artifacts:{id:number;number:number;name:string;body:string;type:string;creator:{id:number};html_url:string}[]=[];
  let posts=0,patches=0,loseEdit=true;
  const api=async(path:string,method='GET',raw?:object):Promise<any>=>{
    if(path==='')return {id:topic.repoId};
    if(path.startsWith('/issues/6/comments?'))return comments;
    if(path.startsWith('/issues/6/artifacts?'))return artifacts;
    if(/^\/issues\/6\/artifacts\/\d+$/.test(path))return {artifact:artifacts[Number(path.split('/').at(-1))-1]};
    const data=raw as {body:string;name:string;type:string};
    if(path==='/issues/6/artifacts' && method==='POST'){
      const num=artifacts.length+1;
      const row={...data,id:num,number:num,creator:{id:40},html_url:'https://github.com/owner/repo/issues/6/artifacts/'+num};artifacts.push(row);return row;
    }
    if(path==='/issues/6/comments' && method==='POST'){
      posts++;const c={id:81,issue_url:'https://api.github.com/repos/owner/repo/issues/6',user:{id:40},body:data.body};comments.push(c);return c;
    }
    if(path==='/issues/comments/81' && method==='GET')return comments[0];
    if(path==='/issues/comments/81' && method==='PATCH'){
      patches++;comments[0]!.body=data.body;if(loseEdit){loseEdit=false;throw Error('lost PATCH response');}return comments[0];
    }
    throw Error('Unexpected '+method+' '+path);
  };
  const credentials=async():Promise<[typeof api,number]>=>[api,40];
  recordProgress(dir,6,'review','The integrator passed this candidate.');
  await publishProgress(dir,topic,credentials);
  const reports=[{purpose:'review' as const,markdown:'# Findings\n\nPass.\n'},{purpose:'tests' as const,markdown:'# Validation\n\n24 tests passed.\n'}];
  recordProgress(dir,6,'review','The integrator passed this candidate.',reports);
  await publishProgress(dir,topic,credentials);db.exec('UPDATE events SET retryAt=0');
  await publishProgress(dir,topic,credentials);
  recordProgress(dir,6,'review','The integrator passed this candidate.',reports);
  assert.equal(await publishProgress(dir,topic,credentials),false);
  assert.equal(posts,1);assert.equal(patches,1);assert.equal(artifacts.length,2);
  assert.equal(comments.length,1);assert.match(comments[0]!.body,/The integrator passed this candidate\. \[review-6-/);
  assert.match(comments[0]!.body,/\[tests-6-/);assert.equal(db.prepare('select receipt from events').get()!.receipt,81);
});

test('adopting a verified legacy specification comment preserves its original ID and other issue history',async t=>{
  const {adoptVerifiedLegacyResult}=await import('../src/work-progress.js');
  const state=await mkdtemp(join(tmpdir(),'legacy-spec-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const url='https://github.com/owner/repo/issues/6/artifacts/1',name='spec-6-a01.md';
  const original='['+name+']('+url+')';
  const owned={id:90,body:original,user:{id:42},issue_url:'https://api.github.com/repos/owner/repo/issues/6'};
  let patches=0;
  const api=async(path:string,method?:string,data?:object)=>{
    if(!path)return {id:10};
    if(path==='/issues/comments/90' && !method)return owned;
    if(path==='/issues/comments/90' && method==='PATCH'){
      patches++;owned.body=(data as {body:string}).body;return owned;
    }
    throw Error('Unexpected request '+path);
  };
  recordProgress(state,6,'spec','Architect handed off the specification.',undefined,[{name,url}]);
  adoptVerifiedLegacyResult(state,6,'spec',90,original);
  const creds=async():Promise<[typeof api,number]>=>[api,42];
  await publishProgress(state,topic,creds);
  assert.match(owned.body,/Architect handed off the specification\. \[spec-6/);
  assert.equal(await publishProgress(state,topic,creds),false);
  assert.equal(patches,1);assert.equal(owned.id,90);
});

test('one live checklist survives replay, retains late files and finishes on its original comment',async t=>{
  const {beginDashboard,storedResultComment}=await import('../src/work-progress.js');
  const dir=await mkdtemp(join(tmpdir(),'checklist-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const rows:{id:number;user:{id:number};body:string;issue_url:string}[]=[];
  const api=async(path:string,method?:string,data?:object)=>{
    if(path==='')return {id:10};
    if(method==='POST'){rows.push({id:87,user:{id:40},body:(data as {body:string}).body,issue_url:'https://api.github.com/repos/owner/repo/issues/6'});return rows[0];}
    if(method==='PATCH')rows[0]!.body=(data as {body:string}).body;
    return path.includes('comments?')?rows:rows[0];
  };
  const publish=()=>publishProgress(dir,topic,async()=>[api,40]);
  beginDashboard(dir,6,'assignment');await publish();assert.match(rows[0]!.body,/⚪ Prepare/);
  recordProgress(dir,6,'waiting-profile','Waiting for project profile read access.');await publish();
  assert.match(rows[0]!.body,/⏸️/);
  beginDashboard(dir,6,'assignment');
  recordProgress(dir,6,'result','The lessons are ready.',undefined,[{name:'lessons.md',url:'https://github.com/owner/repo/issues/6/artifacts/1'}]);
  recordProgress(dir,6,'card-result-verified','Result verified.');await Promise.all([publish(),publish()]);
  assert.equal(rows.length,1);assert.match(rows[0]!.body,/✅ Deliver/);assert.match(rows[0]!.body,/lessons.md/);
  assert.equal(storedResultComment(dir,6,'result'),87);assert.equal(storedResultComment(dir,6,'unknown'),0);
});
test('a denied profile before LEO dispatch retries the same approved intake after reopening the journal',async t=>{
  const {Journal}=await import('../src/intake-journal.js');
  const dir=await mkdtemp(join(tmpdir(),'profile-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'intake.sqlite');let journal=new Journal(path);
  journal.start(topic);journal.enqueue({issue:6,delivery:'original',action:'task',title:'Lessons',body:'All five lessons'});
  assert.equal(journal.next()?.issue,6);journal.deferProfile('original');assert.equal(journal.next(),undefined);journal.db.close();
  journal=new Journal(path);journal.start(topic);journal.db.exec('update intake set seedRetryAt=0');
  assert.equal(journal.next()?.body,'All five lessons');
  journal.complete({delivery:'original',issue:6,disposition:'intake_received'});assert.throws(()=>journal.deferProfile('original'));
  assert.equal(journal.nextWorker()?.delivery,'original');assert.equal(journal.nextWorker(),undefined);journal.db.close();
});

test('development handoffs retain separate role comments and reset worker checks on integration correction',async t=>{
  const {beginDashboard}=await import('../src/work-progress.js');
  const dir=await mkdtemp(join(tmpdir(),'role-checklists-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  beginDashboard(dir,4,'development');
  for(const [id,msg] of [['architecture:1:requested','Draft ready'],['architecture-adviser:1:Codex:ok','Codex responded'],['architecture-adviser:1:Antigravity:error','Unavailable'],['spec-ready:abc','Published'],['validated:abc','Passed'],['integration:abc','Checking candidate'],['fix-spec:abc','Correction attached'],['rework:abc','Worker received correction']]){
    recordProgress(dir,4,id!,msg!);
  }
  const db=new DatabaseSync(join(dir,'work-progress.sqlite'));
  const bodies=db.prepare('SELECT body FROM events ORDER BY rowid').all().map(row=>String(row.body));db.close();
  assert.equal(bodies.length,3);assert.match(bodies[0]!,/\[x\] Codex review/);assert.match(bodies[0]!,/\[ \] Antigravity review/);
  assert.match(bodies[1]!,/Worker:.*\n[^]*\[ \] Pass review/);assert.match(bodies[2]!,/Correction attached/);assert.match(bodies[2]!,/\[ \] Publish the verified revision/);
});
