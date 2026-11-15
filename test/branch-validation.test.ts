import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { IntegrationQueue } from '../src/integration-queue.js';
import { BranchValidation } from '../src/branch-validation.js';

const head=(issue:number)=>({issue,sha:issue.toString(16).padStart(40,'0'),branch:'jam/issue-'+issue});

test('consumer claims ten exact heads as real in-flight checks finish and holds even above three',async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const queue=new IntegrationQueue(db), validations=new BranchValidation(db);
  const waits=new Map<number,()=>void>();
  const validate=(entry:ReturnType<typeof head>)=>new Promise<void>(ok=>waits.set(entry.issue,ok));
  const signal=new AbortController().signal;
  const tick=()=>validations.tick(queue,validate,signal);
  for(let id=1;id<=16;id++) validations.submit(head(id),20_000);
  // Native assignments may run while the first deterministic checks are still active.
  assert.deepEqual(tick(),{batch:undefined,waiting:false});
  await yieldTurn();
  for(let id=1;id<=10;id++){
    assert.ok(waits.has(id));
    waits.get(id)!(); await yieldTurn();
    const {waiting,batch}=tick();
    if(id<10)assert.deepEqual({waiting,batch},{waiting:true,batch:undefined});
    else {
      assert.deepEqual(batch?.entries,Array.from({length:10},(_,i)=>head(i+1)));
      queue.finish(batch!.id,'integrated');
    }
    await yieldTurn();
  }
  for(let id=11;id<=16;id++){
    waits.get(id)!();await yieldTurn();
    const result=tick();await yieldTurn();
    if(id===16)assert.deepEqual(result.batch?.entries.map(e=>e.issue),[11,12,13,14,15,16]);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM branch_validation WHERE state='ready' AND startedAt<=readyAt").get()?.n,16);
  await validations.settle();
});

test('bounded hold expires while a check is late, and recovery repeats only frozen head tests',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const queue=new IntegrationQueue(db), validations=new BranchValidation(db);
  const signal=new AbortController().signal;
  const now=Date.now();
  queue.ready(head(1),now-59_000);
  validations.submit(head(2),500);
  let finish!:()=>void;
  const validate=()=>new Promise<void>(ok=>{finish=ok;});
  assert.equal(validations.tick(queue,validate,signal,now).waiting,true);
  await yieldTurn();
  assert.deepEqual(validations.tick(queue,validate,signal,now+1001).batch?.entries,[head(1)]);
  finish();await validations.settle();
  // Persisted active after process loss, no second ready insertion when resumed.
  db.prepare("UPDATE branch_validation SET state='checking' WHERE issue=2").run();
  validations.recover();
  validations.tick(queue,async()=>{},signal);await validations.settle();
  assert.deepEqual(queue.snapshot().ready,[head(2)]);
});

test('a new architect waits for an overlapping head while independent file scopes can start',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE intake(issue INTEGER,action TEXT,title TEXT,body TEXT,kind TEXT); INSERT INTO intake VALUES(17,'task','Validation','Files: src/calculator.ts, test/arithmetic.ts',NULL)");
  const checks=new BranchValidation(db), queue=new IntegrationQueue(db),signal=new AbortController().signal;
  const next={issue:18,title:'Multiply',delivery:'example',body:'Files: src/calculator.ts, web/index.html'};
  checks.submit(head(17),1200);
  assert.equal(checks.canStart(next),false);
  assert.equal(checks.canStart({...next,body:'Files: src/unrelated.ts'}),true);
  let done!:()=>void;
  checks.tick(queue,()=>new Promise<void>(resolve=>{done=resolve;}),signal);await yieldTurn();
  assert.equal(checks.canStart(next),false);
  done();await checks.settle();
  assert.deepEqual(checks.tick(queue,async()=>{},signal).batch?.entries,[head(17)]);
  assert.equal(checks.canStart(next),true);
});
