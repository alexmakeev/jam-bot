import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IntegrationQueue } from '../src/integration-queue.js';

const head = (issue: number, revision = issue) => ({ issue, branch: 'feature/'+issue, sha:revision.toString(16).padStart(40,'0') });

test('integrate alone immediately; only a bounded concrete ETA can hold compatible work', t => {
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const queue = new IntegrationQueue(db);
  queue.ready(head(1),0);
  assert.equal(queue.claim({nearFinishAt:20_000},1),undefined);
  queue.ready(head(1,99),2);
  assert.equal(queue.claim({nearFinishAt:70_000},30_000)?.entries[0]?.sha,head(1,99).sha);
  queue.finish(queue.active()!.id,'integrated');
  queue.ready(head(2),100_000);
  assert.deepEqual(queue.claim({},100_000)?.entries,[head(2)]);
});

test('durable claims exclude competing coordinators, preserve FIFO and suppress revision replays',t=>{
  const dir=mkdtempSync(join(tmpdir(),'jam-integration-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'queue.db');
  const db=new DatabaseSync(file);
  const queue=new IntegrationQueue(db);
  for(let i=1;i<=31;i++) queue.ready(head(i),i);
  const first=queue.claim()!;
  assert.equal(first.entries.length,10);
  db.close();
  const secondDb=new DatabaseSync(file);
  const thirdDb=new DatabaseSync(file);
  t.after(()=>{secondDb.close();thirdDb.close();});
  const recovered=new IntegrationQueue(secondDb);
  const competitor=new IntegrationQueue(thirdDb);
  assert.deepEqual(recovered.active(),first);
  assert.equal(competitor.claim(),undefined);
  recovered.finish(first.id,'integrated');
  competitor.finish(first.id,'integrated');
  assert.throws(()=>competitor.finish(first.id,'failed'));
  competitor.ready(head(1),99);
  assert.equal(competitor.snapshot().ready.length,21);
  assert.throws(()=>competitor.claim({targetSize:16}));
  const next=competitor.claim({targetSize:15})!;
  assert.equal(next.entries.length,15);
  assert.equal(next.entries[0]!.issue,11);
  recovered.finish(next.id,'failed');
  competitor.ready(head(11),100);
  assert.equal(competitor.snapshot().ready.length,6);
  competitor.ready(head(11,100),101);
  assert.equal(competitor.snapshot().ready.length,7);
});

test('failure preserves evidence and can release unchanged unaffected heads only',t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const queue=new IntegrationQueue(db);
  for(const id of [1,2,3]) queue.ready(head(id));
  const batch=queue.claim()!;
  queue.ready(head(2,20));
  assert.throws(()=>queue.finish(batch.id,'failed',{retryIssues:[77]}));
  queue.finish(batch.id,'failed',{retryIssues:[1,2]});
  assert.deepEqual(queue.snapshot().ready,[head(1),head(2,20)]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM integration_members WHERE batch=?').get(batch.id)?.n,3);
});

test('operator retry rechecks the same failed batch and keeps an audit record', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const queue=new IntegrationQueue(db);
    const head={issue:91,branch:'feature/91',sha:'a'.repeat(40)};
    queue.ready(head);
    const batch=queue.claim()!;
    queue.finish(batch.id,'failed');
    queue.retryFailed(batch.id,'operator','Updated test evidence');
    assert.deepEqual(queue.active(),batch);
    assert.throws(()=>queue.retryFailed(batch.id,'operator','Again'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM integration_retries').get()!.n,1);
  }finally{db.close();}
});
