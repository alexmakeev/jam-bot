import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readProjectSource} from '../src/project-values-reader.js';
import {responsibilities,responsible} from '../src/project-values.js';
import {DecisionPending,requireMaterialDecision,decisionEvidence,decisionKey,pauseDecision,prepareDecisions,requestedDecision,wakeDecision} from '../src/material-decision.js';

const topic={repository:'example/fixture',repoId:17,installation:5,cwd:'/tmp'};
const repo={id:17,default_branch:'main',owner:{login:'fixture-owner',type:'Organization'}};
const owner={id:61,type:'User',login:'fixture-author'},other={id:62,type:'User',login:'fixture-other'};
const text='## Responsibilities\n| Area | Role | GitHub |\n|---|---|---|\n| design | Designer | @fixture-designer |\n| project lead | Lead | @fixture-lead |\n## Release routes\n| Source | Other | Rows |';
const profile={owner:repo.owner.login,markdown:text,responsibilities:responsibilities(text),revision:'1'.repeat(40)};
test('single verified profile commit supplies fragment, area, lead and owner; missing file is valid',async()=>{
 const sha='1'.repeat(40),root='2'.repeat(40),sub='3'.repeat(40);
 const blob=createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0'+text).digest('hex');
 const data:Record<string,any>={'':repo,'/commits/operator-ref':{sha,commit:{tree:{sha:root}}},
  ['/git/trees/'+root]:{sha:root,tree:[{path:'.jam-bot',mode:'040000',sha:sub}]},
  ['/git/trees/'+sub]:{sha:sub,tree:[{path:'VALUES.md',mode:'100644',sha:blob,size:Buffer.byteLength(text)}]},
  ['/git/blobs/'+blob]:{encoding:'base64',content:Buffer.from(text).toString('base64')}};
 const get=(path:string)=>Promise.resolve(data[path.replace('repos/example/fixture','')]);
 assert.deepEqual(await readProjectSource(topic.repository,17,'operator-ref',get),{sha,markdown:text,owner:'fixture-owner'});
 assert.equal(responsible(profile,'Design'),'fixture-designer');assert.equal(responsible(profile,'security'),'fixture-lead');
 assert.equal(responsible({...profile,responsibilities:[]},'design'),'fixture-owner');
 data['/git/trees/'+sub].tree[0].mode='120000';
 await assert.rejects(readProjectSource(topic.repository,17,'operator-ref',get),/Invalid/);
 data['/git/trees/'+sub].tree=[];assert.equal((await readProjectSource(topic.repository,17,'operator-ref',get)).markdown,'');
 await assert.rejects(readProjectSource(topic.repository,18,'operator-ref',get),/identity|mismatch/);
});
test('same authorized initiator scope or independently authorized issue decision; role, mention and unrelated requests give no authority',async()=>{
 const d={area:'design',scope:'Use the compact layout.'},issue=9;
 const ev={issue,title:'Layout',body:d.scope,actorId:owner.id,authorId:owner.id,authorLogin:owner.login};
 const valid='Approve JAM-Bot decision '+decisionKey(17,issue,d)+'.',url='https://api.github.com/repos/example/fixture/issues/9';
 let comments:any[]=[];let authorRole='maintain';
 const read=async(path:string):Promise<any>=>{
  if(path.includes('/comments?'))return comments;
  if(path.includes('/collaborators/')){
    const user=path.includes('fixture-author')?owner:other;
    return {user,role_name:user.id===owner.id?authorRole:'maintain'};
  }return repo;
 };
 assert.equal((await decisionEvidence(topic,ev,d,read))?.source,'original Task');
 assert.equal(await decisionEvidence(topic,{...ev,actorId:other.id},d,read),undefined);
 authorRole='read';
 assert.equal(await decisionEvidence(topic,ev,d,read),undefined);
 const changed={...ev,body:'Ask @fixture-designer to use a different layout.'};
 assert.equal(await decisionEvidence(topic,changed,d,read),undefined);
 comments=[{id:1,user:owner,issue_url:url,body:valid},{id:2,user:other,issue_url:url+'0',body:valid},
  {id:3,user:other,issue_url:url,body:'Approve JAM-Bot decision '+decisionKey(18,issue,d)+'.'}];
 assert.equal(await decisionEvidence(topic,changed,d,read),undefined);
 comments.push({id:4,user:other,issue_url:url,body:valid});
 assert.equal((await decisionEvidence(topic,changed,d,read))?.actor.id,other.id);
 assert.equal(requestedDecision('Example:\n```\nDecision required [design]: Do this.\n```'),undefined);
 assert.deepEqual(requestedDecision('Decision required [design]: Use the compact layout.'),d);
});
test('restart preserves a waiting decision, wakes only the intended issue, including a reply racing with pause',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jam-material-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'state.sqlite');let db=new DatabaseSync(file);
 db.exec("CREATE TABLE intake(issue,action,delivery,workerState);INSERT INTO intake VALUES(1,'task','a','running'),(2,'task','b','running')");
 prepareDecisions(db);db.exec("INSERT INTO material_decisions(issue,digest) VALUES(1,'x'),(2,'y')");
 pauseDecision(db,'a',1,'x');db.close();db=new DatabaseSync(file);
 const state=(issue:number)=>db.prepare('SELECT workerState FROM intake WHERE issue=?').get(issue)?.workerState;
 assert.equal(state(1),'waiting-decision');wakeDecision(db,1,'y');assert.equal(state(1),'waiting-decision');
 wakeDecision(db,1,'x');assert.equal(state(1),'pending');
 wakeDecision(db,2,'y');pauseDecision(db,'b',2,'y');assert.equal(state(2),'pending');db.close();
});

test('material gate pauses, survives restart and records the deciding human in the original issue timeline',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jam-decision-gate-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const d={area:'design',scope:'Use a larger button.'},event={issue:5,actorId:61,authorId:61,authorLogin:'fixture-author',title:'UI',body:'Improve the mobile form.'};
 const digest=decisionKey(topic.repoId,event.issue,d);
 let comments:any[]=[],paused=0;
 const deps={read:async()=>async(path:string)=>path.includes('/comments?')?comments:path.includes('/permission')?{user:other,role_name:'maintain'}:repo,
   status:async()=>{paused++;},publish:async()=>1};
 await assert.rejects(requireMaterialDecision(topic,event,dir,d,profile,deps),DecisionPending);
 assert.equal(paused,1);
 comments=[{user:other,id:7,body:'Approve JAM-Bot decision '+digest+'.',issue_url:'https://api.github.com/repos/example/fixture/issues/5'}];
 await requireMaterialDecision(topic,event,dir,d,profile,deps);
 await requireMaterialDecision(topic,event,dir,d,profile,deps);
 const db=new DatabaseSync(join(dir,'work-progress.sqlite'));
 try{
   const rows=db.prepare('SELECT issue,body FROM events ORDER BY rowid').all();
   assert.equal(rows.length,2);assert.ok(rows.every(row=>row.issue===5));
   assert.match(String(rows[0]?.body),/@fixture-designer/);
   assert.match(String(rows[1]?.body),/Approve by `fixture-other` .*issue comment 7/);
 }finally{db.close();}
});
