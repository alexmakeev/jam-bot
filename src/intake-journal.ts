import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface Topic { repository: string; repoId: number; installation: number; cwd: string }
export interface Intake {
  delivery: string;
  issue: number;
  title: string;
  body: string;
  action?: 'opened' | 'locked';
  actorId?: number;
  actorLogin?: string;
}
export interface Receipt { issue: number; delivery: string; disposition: 'intake_received' }
export interface Lead { id: string; established: boolean }

function intake(row: Record<string, SQLOutputValue>): Intake {
  return {
    delivery: String(row.delivery), issue: Number(row.issue), title: String(row.title), body: String(row.body),
    action: row.action === 'locked' ? 'locked' : 'opened',
    ...(row.actorId == null ? {} : { actorId: Number(row.actorId), actorLogin: String(row.actorLogin) }),
  };
}

const createIntake = `CREATE TABLE intake (
  delivery TEXT PRIMARY KEY, issue INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('opened','locked')),
  title TEXT NOT NULL, body TEXT NOT NULL, actorId INTEGER, actorLogin TEXT,
  state TEXT NOT NULL, receipt TEXT, reason TEXT, workerState TEXT, workerReason TEXT, UNIQUE(issue,action)
)`;

export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Journal integrity check failed');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS topic(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL, session TEXT NOT NULL, established INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS resolutions(delivery TEXT NOT NULL, operator TEXT NOT NULL, decision TEXT NOT NULL, session_state TEXT NOT NULL, time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      `);
      const columns = this.db.prepare('PRAGMA table_info(intake)').all();
      if (!columns.length) this.db.exec(createIntake);
      else if (!columns.some(col => col.name === 'action')) {
        // Keep delivery order and preserve every existing receipt and open assignment.
        this.db.exec('ALTER TABLE intake RENAME TO opened_intake');
        this.db.exec(createIntake);
        this.db.exec(`INSERT INTO intake (rowid,delivery,issue,action,title,body,state,receipt,reason)
          SELECT rowid,delivery,issue,'opened',title,body,state,receipt,reason FROM opened_intake;
          DROP TABLE opened_intake`);
      }
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  start(topic: Topic) {
    this.transaction(() => {
      const binding = JSON.stringify([topic.repoId, topic.installation, topic.repository, topic.cwd]);
      this.db.prepare('INSERT OR IGNORE INTO topic VALUES (1,?,?,0)').run(binding, randomUUID());
      if (this.db.prepare('SELECT binding FROM topic').get()?.binding !== binding) throw new Error('Topic binding changed');
      this.db.exec(`UPDATE intake SET state='review', reason='Service stopped during dispatch' WHERE state='running';
        UPDATE intake SET workerState='review', workerReason='Service stopped during worker dispatch' WHERE workerState='running'`);
    });
  }

  lead(): Lead {
    const row = this.db.prepare('SELECT session, established FROM topic').get();
    if (!row) throw new Error('Missing session binding');
    return { id: String(row.session), established: row.established === 1 };
  }

  enqueue(event: Intake) {
    this.db.prepare(`INSERT INTO intake(delivery,issue,action,title,body,actorId,actorLogin,state)
      VALUES(?,?,?,?,?,?,?,'queued') ON CONFLICT DO NOTHING`)
      .run(event.delivery,event.issue,event.action ?? 'opened',event.title,event.body,event.actorId ?? null,event.actorLogin ?? null);
  }

  next(): Intake | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM intake WHERE state='queued'
        AND NOT EXISTS(SELECT 1 FROM intake WHERE state IN ('review','running') OR workerState IN ('running','review'))
        ORDER BY rowid LIMIT 1`).get();
      if (!row) return;
      this.db.prepare("UPDATE intake SET state='running' WHERE delivery=?").run(row.delivery!);
      return intake(row);
    });
  }

  complete(ack: Receipt) {
    this.transaction(() => {
      // The same transaction that records Leo's verified receipt creates the execution intent.
      const result=this.db.prepare(`UPDATE intake SET state='received', receipt=?,
        workerState=CASE WHEN action='locked' THEN 'pending' END
        WHERE state='running' AND issue=? AND delivery=?`)
        .run(JSON.stringify(ack),ack.issue,ack.delivery);
      if (result.changes !== 1) throw new Error('Acknowledgment has no active intake');
      this.db.exec('UPDATE topic SET established=1');
    });
  }

  nextWorker(): Intake | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM intake WHERE workerState='pending'
        AND NOT EXISTS(SELECT 1 FROM intake WHERE workerState IN ('running','review') OR state IN ('running','review'))
        ORDER BY rowid LIMIT 1`).get();
      if (!row) return;
      this.db.prepare("UPDATE intake SET workerState='running' WHERE delivery=?").run(row.delivery!);
      return intake(row);
    });
  }

  finishWorker(delivery: string, error?: string) {
    const result = this.db.prepare("UPDATE intake SET workerState=?, workerReason=? WHERE delivery=? AND workerState='running'")
      .run(error === undefined ? 'complete' : 'review',error ?? null,delivery);
    if (result.changes !== 1) throw new Error('No active worker intent for this delivery');
  }

  fail(delivery: string, reason: string) {
    this.db.prepare("UPDATE intake SET state='review', reason=? WHERE delivery=? AND state='running'").run(reason,delivery);
  }

  list() {
    return this.db.prepare('SELECT delivery,issue,action,state,reason,receipt,workerState,workerReason FROM intake ORDER BY rowid').all();
  }

  resolve(delivery: string, decision: string, operator: string, session: string) {
    const states: Record<string,string> = { acked:'received', abandon:'abandoned', requeue:'queued' };
    if (!Object.hasOwn(states,decision) || !operator.trim() || !['resume','unused'].includes(session)) throw new Error('Invalid resolution');
    if (session==='unused' && (decision==='acked' || this.lead().established)) throw new Error('An established session must resume');
    this.transaction(() => {
      if (decision==='acked' && this.db.prepare('SELECT action FROM intake WHERE delivery=?').get(delivery)?.action==='locked')
        throw new Error('Locked receipt requires a verified Leo acknowledgment. Inspect the session then requeue or abandon.');
      const result=this.db.prepare("UPDATE intake SET state=?, reason=NULL WHERE delivery=? AND state='review'").run(states[decision]!,delivery);
      if (result.changes!==1) throw new Error('Delivery is not awaiting review');
      this.db.prepare('UPDATE topic SET established=?').run(Number(session==='resume'));
      this.db.prepare('INSERT INTO resolutions(delivery,operator,decision,session_state) VALUES(?,?,?,?)').run(delivery,operator,decision,session);
    });
  }

  resolveWorker(delivery: string, decision: string, operator: string) {
    if (!['complete','abandon'].includes(decision) || !operator.trim()) throw new Error('Expected complete or abandon and an operator');
    this.transaction(() => {
      const result=this.db.prepare("UPDATE intake SET workerState=? WHERE delivery=? AND workerState='review'").run(decision,delivery);
      if (result.changes!==1) throw new Error('No ambiguous worker dispatch for this delivery');
      this.db.prepare('INSERT INTO resolutions(delivery,operator,decision,session_state) VALUES(?,?,?,?)').run(delivery,operator,decision,'worker');
    });
  }
}
