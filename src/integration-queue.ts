import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

export interface ReadyBranch { issue: number; branch: string; sha: string }
export interface IntegrationBatch { id: string; entries: ReadyBranch[] }
export interface BatchOptions { nearFinishAt?: number; targetSize?: number }

const maximumWait = 60_000;
const hardLimit = 15;

function branch(row: Record<string, SQLOutputValue>): ReadyBranch {
  return { issue: Number(row.issue), branch: String(row.branch), sha: String(row.sha) };
}

/** One queue per already-bound repository journal. Times are UTC epoch milliseconds. */
export class IntegrationQueue {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_batches (
        id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('active','integrated','failed'))
      );
      CREATE TABLE IF NOT EXISTS integration_members (
        batch TEXT NOT NULL, issue INTEGER NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(batch,issue)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_batch ON integration_batches(state) WHERE state='active';
      CREATE TABLE IF NOT EXISTS integration_heads (
        issue INTEGER NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, readyAt INTEGER NOT NULL,
        batch TEXT, superseded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(issue,sha)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_ready_issue ON integration_heads(issue)
        WHERE batch IS NULL AND superseded=0;
    `);
  }

  private write<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  ready(head: ReadyBranch, now = Date.now()): void {
    if (!Number.isSafeInteger(head.issue) || head.issue <= 0 || !head.branch.trim() ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.sha)) throw new Error('Invalid integration head');
    this.write(() => {
      const known = this.db.prepare('SELECT branch FROM integration_heads WHERE issue=? AND sha=?').get(head.issue, head.sha);
      if (known) {
        if (known.branch !== head.branch) throw new Error('Conflicting branch for a recorded revision');
        return;
      }
      const queued = this.db.prepare('SELECT readyAt FROM integration_heads WHERE issue=? AND batch IS NULL AND superseded=0').get(head.issue);
      this.db.prepare('UPDATE integration_heads SET superseded=1 WHERE issue=? AND batch IS NULL AND superseded=0').run(head.issue);
      this.db.prepare('INSERT INTO integration_heads(issue,branch,sha,readyAt) VALUES(?,?,?,?)')
        .run(head.issue,head.branch,head.sha,queued?.readyAt ?? now);
    });
  }

  active(): IntegrationBatch | undefined {
    const batch = this.db.prepare("SELECT id FROM integration_batches WHERE state='active'").get();
    if (!batch) return;
    return {
      id:String(batch.id),
      entries:this.db.prepare('SELECT issue,branch,sha FROM integration_heads WHERE batch=? ORDER BY readyAt,rowid')
        .all(batch.id!).map(branch),
    };
  }

  snapshot() {
    return {
      ready:this.db.prepare('SELECT issue,branch,sha FROM integration_heads WHERE batch IS NULL AND superseded=0 ORDER BY readyAt,rowid').all().map(branch),
      active:this.active(),
    };
  }

  claim(options: BatchOptions = {}, now = Date.now()): IntegrationBatch | undefined {
    const target = options.targetSize ?? 10;
    if (!Number.isInteger(target) || target < 1 || target > hardLimit) throw new Error('Batch target must be 1 to 15');
    return this.write(() => {
      if (this.active()) return;
      const rows = this.db.prepare('SELECT * FROM integration_heads WHERE batch IS NULL AND superseded=0 ORDER BY readyAt,rowid LIMIT ?').all(target);
      if (!rows.length) return;
      const deadline = Number(rows[0]!.readyAt) + maximumWait;
      const eta = options.nearFinishAt;
      if (rows.length < target && eta !== undefined && now < eta && eta <= deadline) return;
      const id = randomUUID();
      this.db.prepare("INSERT INTO integration_batches VALUES(?,'active')").run(id);
      const assign = this.db.prepare('UPDATE integration_heads SET batch=? WHERE issue=? AND sha=?');
      const record = this.db.prepare('INSERT INTO integration_members VALUES(?,?,?,?)');
      for (const row of rows) {
        assign.run(id,row.issue!,row.sha!);
        record.run(id,row.issue!,row.branch!,row.sha!);
      }
      return {id, entries:rows.map(branch)};
    });
  }

  retryFailed(id:string, operator:string, reason:string):void {
    if(!operator.trim() || !reason.trim())throw new Error('Integration retry requires an operator and reason');
    this.write(()=>{
      const previous=this.db.prepare('SELECT state FROM integration_batches WHERE id=?').get(id);
      if(previous?.state!=='failed' || this.active())throw new Error('Only one unresolved failed batch can resume');
      const members=this.db.prepare('SELECT issue,sha FROM integration_members WHERE batch=?').all(id);
      if(!members.length || members.some(m=>{
        const head=this.db.prepare('SELECT batch,superseded FROM integration_heads WHERE issue=? AND sha=?').get(m.issue!,m.sha!);
        const replacement=this.db.prepare('SELECT 1 FROM integration_heads WHERE issue=? AND sha<>? AND superseded=0 AND rowid>(SELECT rowid FROM integration_heads WHERE issue=? AND sha=?)').get(m.issue!,m.sha!,m.issue!,m.sha!);
        return head?.batch!==id || head.superseded!==0 || replacement;
      }))throw new Error('Superseded or reassigned batch member');
      this.db.exec('CREATE TABLE IF NOT EXISTS integration_retries(batch TEXT,operator TEXT,reason TEXT,at INTEGER)');
      this.db.prepare('INSERT INTO integration_retries VALUES(?,?,?,?)').run(id,operator,reason,Date.now());
      this.db.prepare("UPDATE integration_batches SET state='active' WHERE id=?").run(id);
    });
  }

  finish(id: string, result: 'integrated'|'failed', options: {retryIssues?: readonly number[]} = {}): void {
    this.write(() => {
      const batch = this.db.prepare('SELECT state FROM integration_batches WHERE id=?').get(id);
      if (batch?.state === result) return;
      if (batch?.state !== 'active') throw new Error('Unknown or already resolved integration batch');
      const unaffected = options.retryIssues ?? [];
      if (unaffected.length && result !== 'failed') throw new Error('Only a failed batch can release unaffected heads');
      for (const issue of new Set(unaffected)) {
        const member = this.db.prepare('SELECT sha FROM integration_members WHERE batch=? AND issue=?').get(id,issue);
        if (!member) throw new Error('Issue is outside the batch');
        const newer = this.db.prepare('SELECT 1 FROM integration_heads WHERE issue=? AND batch IS NULL AND superseded=0').get(issue);
        if (!newer) this.db.prepare('UPDATE integration_heads SET batch=NULL WHERE batch=? AND issue=?').run(id,issue);
      }
      this.db.prepare('UPDATE integration_batches SET state=? WHERE id=?').run(result,id);
    });
  }
}
