import type { DatabaseSync } from 'node:sqlite';
import { IntegrationQueue, type IntegrationBatch, type ReadyBranch } from './integration-queue.js';

type Validation = (head: ReadyBranch) => Promise<void>;
interface Tick { batch?: IntegrationBatch; waiting: boolean }

/** Final deterministic checks run outside the repository's one native coordinator session. */
export class BranchValidation {
  private readonly active = new Map<number,Promise<void>>();
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS branch_validation(
      issue INTEGER NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, submittedAt INTEGER NOT NULL,
      elapsedEstimate INTEGER NOT NULL, startedAt INTEGER, readyAt INTEGER, error TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','checking','ready','failed')), PRIMARY KEY(issue,sha))`);
  }

  submit(head:ReadyBranch, elapsedMs:number) {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs<1 || !Number.isSafeInteger(head.issue) || head.issue<1 ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.sha)) throw Error('Invalid reviewed branch handoff');
    this.db.prepare(`INSERT INTO branch_validation(issue,branch,sha,submittedAt,elapsedEstimate,state)
      VALUES(?,?,?,?,?,'pending') ON CONFLICT(issue,sha) DO NOTHING`)
      .run(head.issue,head.branch,head.sha,Date.now(),elapsedMs);
  }

  recover() {
    // Only immutable, read-only checks may be repeated. The service already holds its owner lock.
    this.db.exec("UPDATE branch_validation SET state='pending', startedAt=NULL WHERE state='checking'");
  }

  async settle() {await Promise.all(this.active.values());}

  tick(queue:IntegrationQueue, validate:Validation, signal:AbortSignal, now = Date.now()): Tick {
    // Keep tests off Leo's call stack and bound the local test load. Queueing alone is not a near-finish signal.
    while (!signal.aborted && this.active.size<3) {
      const row=this.db.prepare("SELECT rowid AS id,* FROM branch_validation WHERE state='pending' ORDER BY submittedAt,rowid LIMIT 1").get();
      if (!row) break;
      const head={issue:Number(row.issue),branch:String(row.branch),sha:String(row.sha)};
      const id=Number(row.id);
      this.db.prepare("UPDATE branch_validation SET state='checking',startedAt=? WHERE rowid=?").run(now,id);
      const task=Promise.resolve().then(()=>validate(head)).then(()=>{
        const readyAt=Date.now();
        // An interruption between these writes repeats a read-only check. Queue insertion is idempotent.
        queue.ready(head,readyAt);
        this.db.prepare("UPDATE branch_validation SET state='ready',readyAt=? WHERE rowid=?").run(readyAt,id);
      }).catch(error=>{
        const reason=error instanceof Error ? error.message : 'Head validation failed';
        this.db.prepare('UPDATE branch_validation SET state=?,error=? WHERE rowid=?')
          .run(signal.aborted ? 'pending' : 'failed',reason.slice(0,1000),id);
      }).finally(()=>{this.active.delete(id);});
      this.active.set(id,task);
    }
    const current=queue.active();
    if(current)return {batch:current,waiting:false};
    const row=this.db.prepare(`SELECT MIN(startedAt+elapsedEstimate) AS eta FROM branch_validation
      WHERE state='checking' AND startedAt+elapsedEstimate>?`).get(now);
    const eta=row?.eta==null ? undefined : Number(row.eta);
    const batch=queue.claim({targetSize:10,nearFinishAt:eta},now);
    return {batch,waiting:!batch && queue.snapshot().ready.length>0};
  }
}
