import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface Topic { repository: string; repoId: number; installation: number; cwd: string }
export interface Intake { delivery: string; issue: number; title: string; body: string }
export interface Receipt { issue: number; delivery: string; disposition: 'intake_received' }
export interface Lead { id: string; established: boolean }

export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Journal integrity check failed');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL, session TEXT NOT NULL, established INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intake(delivery TEXT PRIMARY KEY, issue INTEGER UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS resolutions(delivery TEXT NOT NULL, operator TEXT NOT NULL, decision TEXT NOT NULL, session_state TEXT NOT NULL, time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
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
      this.db.exec("UPDATE intake SET state='review', reason='Service stopped during dispatch' WHERE state='running'");
    });
  }
  lead(): Lead {
    const row = this.db.prepare('SELECT session, established FROM topic').get();
    if (!row) throw new Error('Missing session binding');
    return { id: String(row.session), established: row.established === 1 };
  }
  enqueue(event: Intake) {
    this.db.prepare("INSERT INTO intake(delivery,issue,title,body,state) VALUES(?,?,?,?,'queued') ON CONFLICT DO NOTHING")
      .run(event.delivery, event.issue, event.title, event.body);
  }
  next(): Intake | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT delivery,issue,title,body FROM intake WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM intake WHERE state IN ('review','running')) ORDER BY rowid LIMIT 1").get();
      if (!row) return;
      this.db.prepare("UPDATE intake SET state='running' WHERE delivery=?").run(row.delivery!);
      return { delivery: String(row.delivery), issue: Number(row.issue), title: String(row.title), body: String(row.body) };
    });
  }
  complete(ack: Receipt) {
    this.transaction(() => {
      const result=this.db.prepare("UPDATE intake SET state='received',receipt=? WHERE state='running' AND issue=? AND delivery=?")
        .run(JSON.stringify(ack),ack.issue,ack.delivery);
      if (result.changes !== 1) throw new Error('Acknowledgment has no active intake');
      this.db.exec('UPDATE topic SET established=1');
    });
  }
  fail(delivery: string, reason: string) {
    this.db.prepare("UPDATE intake SET state='review', reason=? WHERE delivery=? AND state='running'").run(reason,delivery);
  }
  list() { return this.db.prepare('SELECT delivery,issue,state,reason,receipt FROM intake ORDER BY rowid').all(); }
  resolve(delivery: string, decision: string, operator: string, session: string) {
    const states: Record<string,string> = { acked:'received', abandon:'abandoned', requeue:'queued' };
    if (!Object.hasOwn(states,decision) || !operator.trim() || !['resume','unused'].includes(session)) throw new Error('Invalid resolution');
    if (session==='unused' && (decision==='acked' || this.lead().established)) throw new Error('An established session must resume');
    this.transaction(() => {
      const result=this.db.prepare("UPDATE intake SET state=?, reason=NULL WHERE delivery=? AND state='review'").run(states[decision]!,delivery);
      if (result.changes!==1) throw new Error('Delivery is not awaiting review');
      this.db.prepare('UPDATE topic SET established=?').run(Number(session==='resume'));
      this.db.prepare('INSERT INTO resolutions(delivery,operator,decision,session_state) VALUES(?,?,?,?)').run(delivery,operator,decision,session);
    });
  }
}
