import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {DependencyHold,checkDependencyGraph,nativeDependencies,verifyDependencyPublication} from '../src/github-dependencies.js';
import {IntegrationQueue} from '../src/integration-queue.js';
import {git} from '../src/profile-checkout.js';
import {atomicJson} from '../src/storage.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const repo='owner/repo';
const source=(number:number)=>({number,id:9500+number,repository_url:'https://api.github.com/repos/'+repo});
const head=(issue:number)=>({issue,branch:'jam/issue-'+issue,sha:String(issue).repeat(40)});

test('approved native edges reconcile response loss, and a grouped successor waits through rework and restart',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    let queue=new IntegrationQueue(db);
    const edges=new Map<number,number[]>();
    const recorded=new Set<number>();
    let writes=0,approvals=0;
    const graph=()=>checkDependencyGraph({
      repository:repo,issue:3,expected:[1,2],
      read:async path=>{
        const issue=Number(path.split('/')[2]);
        return path.includes('/blocked_by?')?(edges.get(issue)??[]).map(source):source(issue);
      },
      authorize:async()=>{approvals++;},
      claim:edge=>recorded.has(edge.id),
      confirm:edge=>{recorded.add(edge.id);},
      write:async(path,method,body)=>{
        assert.equal(path,'/issues/3/dependencies/blocked_by');assert.equal(method,'POST');
        const existing=edges.get(3)??[];
        const blocker=(body as {issue_id:number}).issue_id-9500;
        edges.set(3,[...existing,blocker]);
        if(++writes===1)throw Error('response lost after GitHub accepted edge');
      },
      integrated:async edge=>{
        const member = db.prepare(`SELECT m.sha FROM integration_members m JOIN integration_batches b ON b.id=m.batch
          WHERE b.state='integrated' AND m.issue=?`).get(edge.issue);
        return typeof member?.sha==='string'?member.sha:undefined;
      },
    });
    await assert.rejects(graph(),error=>error instanceof DependencyHold&&error.message.includes('#1'));
    assert.equal(writes,2);assert.equal(approvals,2);
    queue.ready(head(1));queue.ready(head(2));queue.ready(head(3));
    const group=queue.claim({eligible:entry=>entry.issue!==3})!;
    assert.deepEqual(group.entries.map(entry=>entry.issue),[1,2]);
    queue.finish(group.id,'failed',{retryIssues:[1]});
    queue=new IntegrationQueue(db);
    const unaffected=queue.claim({eligible:entry=>entry.issue!==3})!;
    assert.deepEqual(unaffected.entries.map(entry=>entry.issue),[1]);
    queue.finish(unaffected.id,'integrated');
    await assert.rejects(graph(),error=>error instanceof DependencyHold&&error.message.includes('#2'));
    assert.equal(writes,2);
    const corrected={...head(2),sha:'a'.repeat(40)};
    queue.ready(corrected);
    const replacement=queue.claim({eligible:entry=>entry.issue!==3})!;
    queue=new IntegrationQueue(db);
    assert.deepEqual(queue.active(),replacement);
    queue.finish(replacement.id,'integrated');
    assert.deepEqual(await graph(),[head(1).sha,corrected.sha]);
    assert.deepEqual(queue.claim()!.entries,[head(3)]);
    edges.set(3,[1]);
    await assert.rejects(graph(),/Approved dependency #2 was removed/);
    assert.equal(writes,2);
  }finally{db.close();}
});

test('native dependency discovery reads the final page and holds invalid, foreign and cyclic dependencies',async()=>{
  let pages=0;
  const listed=await nativeDependencies(async path=>{
    pages++;
    return path.endsWith('page=1')?Array.from({length:100},(_,index)=>source(index+1)):[];
  },repo,200);
  assert.equal(pages,2);
  assert.equal(listed.length,100);
  await assert.rejects(nativeDependencies(async()=>[{...source(1),repository_url:'https://api.github.com/repos/elsewhere/repo'}],repo,2),DependencyHold);
  await assert.rejects(nativeDependencies(async()=>[{...source(1),pull_request:{}}],repo,2),DependencyHold);
  await assert.rejects(checkDependencyGraph({repository:repo,issue:1,authorize:async()=>{},integrated:async()=>head(2).sha,
    read:async path=>path.startsWith('/issues/1/')?[source(2)]:[source(1)],write:async()=>assert.fail('A cyclic graph must not change GitHub'),
  }),/cycle #1 → #2 → #1/);
});

test('after restart, a grouped dependency releases only with an exact attested dev publication',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-dependency-publication-'));
  t.after(()=>rm(state,{recursive:true,force:true}));
  await git(state,'init','project.git');
  const tree=join(state,'project.git');
  const commit=async(label:string)=>{
    await writeFile(join(tree,label),label);
    await git(tree,'add',label);
    await git(tree,'commit','-m',label);
    return git(tree,'rev-parse','HEAD');
  };
  const base=await commit('base');
  const first=await commit('feature-1');
  const second=await commit('feature-2');
  const candidate=await commit('candidate');
  const currentDev=await commit('other-published-change');
  const database=join(state,'intake.sqlite');
  let db=new DatabaseSync(database);
  const queue=new IntegrationQueue(db);
  queue.ready({...head(1),sha:first});queue.ready({...head(2),sha:second});
  const batch=queue.claim()!;
  queue.finish(batch.id,'integrated');
  db.close();
  db=new DatabaseSync(database);
  t.after(()=>db.close());
  const folder=join(state,'integration',batch.id);
  await atomicJson(join(folder,'candidate.json'),{sha:candidate});
  await atomicJson(join(state,'assignments','2','closed.json'),{issue:2,head:second,dev:candidate});
  const verified=(issue:number,dev=currentDev,checkout?:string)=>verifyDependencyPublication(state,repo,db,issue,async()=>dev,checkout);
  assert.equal(await verified(2),undefined);
  await atomicJson(join(folder,'publication-intent.json'),{action:'publish',repo,sha:candidate,cards:[{issue:1},{issue:2}]});
  await atomicJson(join(folder,'published.json'),{sha:candidate});
  assert.equal(await verified(1),candidate);
  assert.equal(await verified(2),candidate);
  assert.equal(await verified(2,base),undefined);
  assert.equal(await verified(3),undefined);
  await assert.rejects(verified(2,currentDev,base),/Checkout base must be reconciled/);
});

test('a late dependency holds only its exact, unintegrated head across receiver restart',async t=>{
  const state=await mkdtemp(join(tmpdir(),'jam-late-dependency-'));t.after(()=>rm(state,{recursive:true,force:true}));
  const database=join(state,'intake.sqlite');
  let db=new DatabaseSync(database);
  let queue=new IntegrationQueue(db);
  queue.ready(head(1));queue.ready(head(2));
  const group=queue.claim()!;
  queue.finish(group.id,'failed',{retryIssues:[1,2],dependencyHold:{issue:2,epoch:3}});
  db.close();
  db=new DatabaseSync(database);t.after(()=>db.close());
  queue=new IntegrationQueue(db);
  assert.equal(queue.dependencyHeld(head(2),3),true);
  const eligible=queue.claim({eligible:entry=>!queue.dependencyHeld(entry,3)})!;
  assert.deepEqual(eligible.entries,[head(1)]);
  queue.finish(eligible.id,'integrated');
  assert.equal(queue.claim({eligible:entry=>!queue.dependencyHeld(entry,3)}),undefined);
  const resumed=queue.claim({eligible:entry=>!queue.dependencyHeld(entry,4)})!;
  assert.deepEqual(resumed.entries,[head(2)]);
});
