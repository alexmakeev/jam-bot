import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ConsultationSubmission } from "./profile-checkout.js";

export interface AdviceWait extends ConsultationSubmission {
	head: string;
	approval: string;
	files: string[];
}

export interface Topic {
	repository: string;
	repoId: number;
	installation: number;
	cwd: string;
	defaultEnvironment?: string;
	defaultClass?: import("./profile-card.js").ProfileKind;
}
export interface Intake {
	delivery: string;
	issue: number;
	title: string;
	body: string;
	action?: "opened" | "locked" | "task";
	typeId?: number;
	authorId?: number;
	authorLogin?: string;
	kind?: "assignment" | "development" | "consultation";
	approvalSource?: "opened" | "typed";
	actorId?: number;
	actorLogin?: string;
}
export interface Receipt {
	issue: number;
	delivery: string;
	disposition: "intake_received";
}
export interface Lead {
	id: string;
	established: boolean;
}

function intake(row: Record<string, SQLOutputValue>): Intake {
	return {
		delivery: String(row.delivery),
		issue: Number(row.issue),
		title: String(row.title),
		body: String(row.body),
		action:
			row.action === "task"
				? "task"
				: row.action === "locked"
					? "locked"
					: "opened",
		...(row.typeId == null
			? {}
			: {
					typeId: Number(row.typeId),
					approvalSource: row.approvalSource as "opened" | "typed",
				}),
		...(row.authorId == null
			? {}
			: {
					authorId: Number(row.authorId),
					authorLogin: String(row.authorLogin),
				}),
		...(row.kind == null ? {} : { kind: row.kind as Intake["kind"] }),
		...(row.actorId == null
			? {}
			: { actorId: Number(row.actorId), actorLogin: String(row.actorLogin) }),
	};
}

const createIntake = `CREATE TABLE intake (
  delivery TEXT PRIMARY KEY, issue INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('opened','locked','task')),
  title TEXT NOT NULL, body TEXT NOT NULL, actorId INTEGER, actorLogin TEXT, typeId INTEGER, approvalSource TEXT, authorId INTEGER, authorLogin TEXT, kind TEXT,
  state TEXT NOT NULL, receipt TEXT, reason TEXT, workerState TEXT, workerReason TEXT, UNIQUE(issue,action)
)`;

export class Journal {
	readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
		);
		if (this.db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
			throw new Error("Journal integrity check failed");
		this.transaction(() => {
			this.db.exec(`
        CREATE TABLE IF NOT EXISTS topic(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL, session TEXT NOT NULL, established INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS resolutions(delivery TEXT NOT NULL, operator TEXT NOT NULL, decision TEXT NOT NULL, session_state TEXT NOT NULL, time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS dependency_wakeup(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL);
        INSERT OR IGNORE INTO dependency_wakeup VALUES(1,0);
        CREATE TABLE IF NOT EXISTS dependency_wakeup_events(delivery TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS dependency_claims(
          issue INTEGER NOT NULL, blocker INTEGER NOT NULL, githubId INTEGER NOT NULL, confirmed INTEGER NOT NULL,
          PRIMARY KEY(issue,blocker)
        );
        CREATE TABLE IF NOT EXISTS worker_advice_waits(delivery TEXT PRIMARY KEY, snapshot TEXT NOT NULL, resumed INTEGER NOT NULL DEFAULT 0);
      `);
			const columns = this.db.prepare("PRAGMA table_info(intake)").all();
			if (!columns.length) this.db.exec(createIntake);
			else if (!columns.some((col) => col.name === "action")) {
				// Keep delivery order and preserve every existing receipt and open assignment.
				this.db.exec("ALTER TABLE intake RENAME TO opened_intake");
				this.db.exec(createIntake);
				this.db.exec(`INSERT INTO intake (rowid,delivery,issue,action,title,body,state,receipt,reason)
          SELECT rowid,delivery,issue,'opened',title,body,state,receipt,reason FROM opened_intake;
          DROP TABLE opened_intake`);
			} else if (!columns.some((col) => col.name === "typeId")) {
				const previous = columns.map((col) => String(col.name)).join(",");
				this.db.exec("ALTER TABLE intake RENAME TO legacy_intake");
				this.db.exec(createIntake);
				this.db.exec(
					"INSERT INTO intake(rowid," +
						previous +
						") SELECT rowid," +
						previous +
						" FROM legacy_intake; DROP TABLE legacy_intake",
				);
				this.db.exec(
					"UPDATE intake SET workerState='abandoned', workerReason='Native Task approval required' WHERE action='locked' AND workerState='pending'",
				);
			}
			if (!columns.some((col) => col.name === "seedRetryAt"))
				this.db.exec(
					"ALTER TABLE intake ADD COLUMN seedRetryAt INTEGER NOT NULL DEFAULT 0",
				);
			if (
				!this.db
					.prepare(
						"SELECT 1 FROM pragma_table_info('intake') WHERE name='specCheckpoint'",
					)
					.get()
			)
				this.db.exec("ALTER TABLE intake ADD COLUMN specCheckpoint TEXT");
			if (
				!this.db
					.prepare(
						"SELECT 1 FROM pragma_table_info('intake') WHERE name='integrationParked'",
					)
					.get()
			)
				this.db.exec(
					"ALTER TABLE intake ADD COLUMN integrationParked INTEGER NOT NULL DEFAULT 0",
				);
			if (
				!this.db
					.prepare(
						"SELECT 1 FROM pragma_table_info('intake') WHERE name='lockVerified'",
					)
					.get()
			) {
				this.db.exec(
					"ALTER TABLE intake ADD COLUMN lockVerified INTEGER NOT NULL DEFAULT 0",
				);
				// Previous versions left the lock to the consumer. Recover their queued signed approvals at startup.
				this.db.exec(
					"UPDATE intake SET state='admitting' WHERE action='task' AND state='queued'",
				);
			}
		});
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	start(topic: Topic) {
		this.transaction(() => {
			const binding = JSON.stringify([
				topic.repoId,
				topic.installation,
				topic.repository,
				topic.cwd,
			]);
			this.db
				.prepare("INSERT OR IGNORE INTO topic VALUES (1,?,?,0)")
				.run(binding, randomUUID());
			if (
				this.db.prepare("SELECT binding FROM topic").get()?.binding !== binding
			)
				throw new Error("Topic binding changed");
			this.db.exec(`UPDATE intake SET state='review', reason='Service stopped during dispatch' WHERE state='running';
        UPDATE intake SET workerState='pending' WHERE workerState='running' AND specCheckpoint IS NOT NULL;
        UPDATE intake SET workerState='review', workerReason='Service stopped during worker dispatch' WHERE workerState='running'`);
		});
	}

	lead(): Lead {
		const row = this.db.prepare("SELECT session, established FROM topic").get();
		if (!row) throw new Error("Missing session binding");
		return { id: String(row.session), established: row.established === 1 };
	}

	enqueue(event: Intake, state: "admitting" | "queued" = "queued") {
		this.db
			.prepare(`INSERT INTO intake(delivery,issue,action,title,body,actorId,actorLogin,typeId,approvalSource,authorId,authorLogin,kind,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
			.run(
				event.delivery,
				event.issue,
				event.action ?? "opened",
				event.title,
				event.body,
				event.actorId ?? null,
				event.actorLogin ?? null,
				event.typeId ?? null,
				event.approvalSource ?? null,
				event.authorId ?? null,
				event.authorLogin ?? null,
				event.kind ?? null,
				state,
			);
	}

	beginAdmission(event: Intake): { event: Intake; state: string } | undefined {
		return this.transaction(() => {
			this.enqueue(event, "admitting");
			const row = this.db
				.prepare("SELECT * FROM intake WHERE issue=? AND action='task'")
				.get(event.issue);
			if (
				!row ||
				row.actorId !== event.actorId ||
				row.authorId !== event.authorId ||
				row.typeId !== event.typeId ||
				row.title !== event.title ||
				row.body !== event.body ||
				(row.kind ?? undefined) !== event.kind
			)
				return;
			return { event: intake(row), state: String(row.state) };
		});
	}

	pendingAdmissions(): Intake[] {
		return this.db
			.prepare("SELECT * FROM intake WHERE state='admitting' ORDER BY rowid")
			.all()
			.map(intake);
	}

	finishAdmission(delivery: string, rejection?: string) {
		this.db
			.prepare(
				"UPDATE intake SET state=?,lockVerified=?,reason=? WHERE delivery=? AND state='admitting'",
			)
			.run(
				rejection ? "rejected" : "queued",
				rejection ? 0 : 1,
				rejection ?? null,
				delivery,
			);
	}

	next(): Intake | undefined {
		return this.transaction(() => {
			const row = this.db
				.prepare(`SELECT * FROM intake WHERE state='queued' AND seedRetryAt<=unixepoch()
        AND NOT EXISTS(SELECT 1 FROM intake WHERE state IN ('review','running') OR workerState IN ('running','review'))
        ORDER BY rowid LIMIT 1`)
				.get();
			if (!row) return;
			this.db
				.prepare("UPDATE intake SET state='running' WHERE delivery=?")
				.run(row.delivery!);
			return intake(row);
		});
	}

	hasQueuedIntake() {
		return Boolean(
			this.db
				.prepare(
					"SELECT 1 FROM intake WHERE state='queued' AND seedRetryAt<=unixepoch() LIMIT 1",
				)
				.get(),
		);
	}

	activeAdviceWaits() {
		return this.db
			.prepare(`SELECT i.delivery, w.snapshot FROM worker_advice_waits w JOIN intake i ON i.delivery=w.delivery
      WHERE i.workerState='waiting-advice' AND w.resumed=0 ORDER BY i.rowid`)
			.all()
			.map((row) => ({
				delivery: String(row.delivery),
				wait: JSON.parse(String(row.snapshot)) as AdviceWait,
			}));
	}

	adviceWait(delivery: string) {
		const prior = this.db
			.prepare(
				"SELECT snapshot,resumed FROM worker_advice_waits WHERE delivery=?",
			)
			.get(delivery);
		return prior
			? {
					wait: JSON.parse(String(prior.snapshot)) as AdviceWait,
					resumed: prior.resumed === 1,
				}
			: undefined;
	}

	suspendForAdvice(delivery: string, wait: AdviceWait) {
		this.transaction(() => {
			const pending = this.activeAdviceWaits();
			if (
				pending.length >= 2 ||
				pending.some((row) =>
					row.wait.files.some((path) => wait.files.includes(path)),
				)
			)
				throw Error("Consultation wait would exceed the topic scope");
			const result = this.db
				.prepare(
					"UPDATE intake SET workerState='waiting-advice' WHERE delivery=? AND workerState='running' AND specCheckpoint IS NOT NULL",
				)
				.run(delivery);
			if (result.changes !== 1)
				throw Error("Missing worker ownership for consultation wait");
			this.db
				.prepare(
					"INSERT INTO worker_advice_waits(delivery,snapshot) VALUES(?,?)",
				)
				.run(delivery, JSON.stringify(wait));
		});
	}

	resumeAdvice(delivery: string) {
		return this.transaction(() => {
			const row = this.db
				.prepare(`SELECT i.* FROM intake i JOIN worker_advice_waits w ON w.delivery=i.delivery
        WHERE i.delivery=? AND i.workerState='waiting-advice' AND w.resumed=0
        AND NOT EXISTS(SELECT 1 FROM intake WHERE workerState IN ('running','review') OR state IN ('running','review'))`)
				.get(delivery);
			if (!row) return;
			this.db
				.prepare(
					"UPDATE intake SET workerState='running',workerReason=NULL WHERE delivery=?",
				)
				.run(delivery);
			this.db
				.prepare("UPDATE worker_advice_waits SET resumed=1 WHERE delivery=?")
				.run(delivery);
			return intake(row);
		});
	}

	yieldWorker(delivery: string) {
		const result = this.db
			.prepare(
				"UPDATE intake SET workerState='pending' WHERE delivery=? AND workerState='running' AND specCheckpoint IS NOT NULL",
			)
			.run(delivery);
		if (result.changes !== 1)
			throw Error("Missing worker checkpoint at native stage boundary");
	}

	parkWorkerForIntegration(delivery: string) {
		const result = this.db
			.prepare(`UPDATE intake SET workerState='pending',integrationParked=1
      WHERE delivery=? AND workerState='running' AND specCheckpoint IS NOT NULL`)
			.run(delivery);
		if (result.changes !== 1)
			throw Error("Missing worker checkpoint at integration boundary");
	}

	hasIntegrationContinuation() {
		return Boolean(
			this.db
				.prepare(`SELECT 1 FROM intake WHERE action='task' AND workerState='pending'
      AND integrationParked=1 AND seedRetryAt<=unixepoch() LIMIT 1`)
				.get(),
		);
	}

	complete(ack: Receipt, recovered = false) {
		this.transaction(() => {
			// The same transaction that records JAM's verified receipt creates the execution intent.
			const result = this.db
				.prepare(`UPDATE intake SET state='received', reason=NULL,receipt=?,
        workerState=CASE WHEN action='task' THEN 'pending' END
        WHERE (state='running' OR (? AND state='review' AND reason='Service stopped during dispatch')) AND issue=? AND delivery=?`)
				.run(JSON.stringify(ack), Number(recovered), ack.issue, ack.delivery);
			if (result.changes !== 1)
				throw new Error("Acknowledgment has no active intake");
			this.db.exec("UPDATE topic SET established=1");
		});
	}

	nextWorker(
		canStart: (task: Intake) => boolean = () => true,
		checkpointable: (task: Intake) => boolean = () => false,
	): Intake | undefined {
		return this.transaction(() => {
			const rows = this.db
				.prepare(`SELECT * FROM intake WHERE action='task' AND workerState='pending' AND seedRetryAt<=unixepoch()
        AND NOT EXISTS(SELECT 1 FROM intake WHERE workerState IN ('running','review') OR state IN ('running','review'))
        AND (SELECT COUNT(*) FROM intake WHERE workerState='waiting-advice')<2
        ORDER BY integrationParked DESC,rowid`)
				.all();
			const row = rows.find((item) => canStart(intake(item)));
			if (!row) return;
			this.db
				.prepare(`UPDATE intake SET workerState='running',workerReason=NULL,integrationParked=0,
        specCheckpoint=COALESCE(specCheckpoint,?) WHERE delivery=?`)
				.run(checkpointable(intake(row)) ? "starting" : null, row.delivery!);
			return intake(row);
		});
	}

	pendingWorkers() {
		return this.db
			.prepare(`SELECT * FROM intake WHERE action='task' AND workerState='pending' AND seedRetryAt<=unixepoch()
      AND NOT EXISTS(SELECT 1 FROM intake WHERE workerState IN ('running','review') OR state IN ('running','review'))
      AND (SELECT COUNT(*) FROM intake WHERE workerState='waiting-advice')<2 ORDER BY integrationParked DESC,rowid`)
			.all()
			.map(intake);
	}

	workerCandidates() {
		return this.db
			.prepare(
				"SELECT * FROM intake WHERE action='task' AND workerState='pending' AND seedRetryAt<=unixepoch() ORDER BY rowid",
			)
			.all()
			.map(intake);
	}

	dependencyEpoch() {
		return Number(
			this.db
				.prepare("SELECT epoch FROM dependency_wakeup WHERE singleton=1")
				.get()!.epoch,
		);
	}

	wakeDependencies(delivery?: string) {
		this.transaction(() => {
			if (
				delivery &&
				!this.db
					.prepare("INSERT OR IGNORE INTO dependency_wakeup_events VALUES(?)")
					.run(delivery).changes
			)
				return;
			this.db.exec(
				"UPDATE dependency_wakeup SET epoch=epoch+1 WHERE singleton=1",
			);
		});
	}

	waitForDependencies(delivery: string, reason: string) {
		this.db
			.prepare(
				"UPDATE intake SET workerState='pending',workerReason=?,integrationParked=0 WHERE delivery=? AND workerState IN ('pending','running')",
			)
			.run(reason, delivery);
	}

	withdrawPendingWorker(delivery: string) {
		const result = this.db
			.prepare(
				"UPDATE intake SET workerState='abandon',workerReason='Verified GitHub withdrawal before work',integrationParked=0 WHERE delivery=? AND workerState='pending' AND state='received'",
			)
			.run(delivery);
		if (result.changes !== 1)
			throw Error("No pending work to withdraw for this delivery");
	}

	specificationCheckpoint(issue: number): string | null {
		const row = this.db
			.prepare(
				"SELECT specCheckpoint FROM intake WHERE issue=? AND action='task' AND workerState='running'",
			)
			.get(issue);
		return row?.specCheckpoint == null ? null : String(row.specCheckpoint);
	}

	checkpointSpecification(issue: number, checkpoint: string | null) {
		const result = this.db
			.prepare(
				"UPDATE intake SET specCheckpoint=? WHERE issue=? AND action='task' AND workerState='running'",
			)
			.run(checkpoint, issue);
		if (result.changes !== 1)
			throw Error("Missing active worker for specification handoff");
	}

	deferProfile(delivery: string) {
		const result = this.db
			.prepare(
				"UPDATE intake SET state='queued',seedRetryAt=unixepoch()+60,reason='Waiting for profile read access' WHERE delivery=? AND state='running' AND receipt IS NULL AND workerState IS NULL",
			)
			.run(delivery);
		if (result.changes !== 1) throw Error("Cannot defer after dispatch");
	}

	deferPublisherSeed(delivery: string) {
		const result = this.db
			.prepare(
				"UPDATE intake SET workerState='pending',seedRetryAt=unixepoch()+60,workerReason='Waiting for publisher configuration' WHERE delivery=? AND workerState='running'",
			)
			.run(delivery);
		if (result.changes !== 1) throw Error("No active delivery to defer");
	}

	retryDeniedSeed(delivery: string, operator: string) {
		if (!operator.trim()) throw Error("Expected operator");
		this.transaction(() => {
			const result = this.db
				.prepare(
					"UPDATE intake SET workerState='pending',workerReason=NULL WHERE delivery=? AND workerState='review' AND workerReason='Profile broker: Repository outside publisher scope' AND specCheckpoint IS NULL",
				)
				.run(delivery);
			if (result.changes !== 1)
				throw Error("Worker was not stopped by publisher scope");
			this.db
				.prepare(
					"INSERT INTO resolutions(delivery,operator,decision,session_state) VALUES(?,?,?,?)",
				)
				.run(delivery, operator, "retry-seed", "worker");
		});
	}

	finishWorker(delivery: string, error?: string) {
		const result = this.db
			.prepare(
				"UPDATE intake SET workerState=?, workerReason=? WHERE delivery=? AND workerState='running'",
			)
			.run(
				error === undefined ? "complete" : "review",
				error ?? null,
				delivery,
			);
		if (result.changes !== 1)
			throw new Error("No active worker intent for this delivery");
	}

	fail(delivery: string, reason: string) {
		this.db
			.prepare(
				"UPDATE intake SET state='review', reason=? WHERE delivery=? AND state='running'",
			)
			.run(reason, delivery);
	}

	withdrawIntake(delivery: string) {
		this.db
			.prepare(
				"UPDATE intake SET state='abandoned', reason='Verified GitHub withdrawal before intake' WHERE delivery=? AND state='running' AND receipt IS NULL",
			)
			.run(delivery);
	}

	list() {
		return this.db
			.prepare(
				"SELECT delivery,issue,action,actorId,actorLogin,typeId,approvalSource,authorId,authorLogin,kind,lockVerified,state,reason,receipt,workerState,workerReason FROM intake ORDER BY rowid",
			)
			.all();
	}

	resolve(
		delivery: string,
		decision: string,
		operator: string,
		session: string,
	) {
		const states: Record<string, string> = {
			acked: "received",
			abandon: "abandoned",
			requeue: "queued",
		};
		if (
			!Object.hasOwn(states, decision) ||
			!operator.trim() ||
			!["resume", "unused"].includes(session)
		)
			throw new Error("Invalid resolution");
		if (
			session === "unused" &&
			(decision === "acked" || this.lead().established)
		)
			throw new Error("An established session must resume");
		this.transaction(() => {
			if (
				decision === "acked" &&
				this.db
					.prepare("SELECT action FROM intake WHERE delivery=?")
					.get(delivery)?.action === "task"
			)
				throw new Error(
					"Task receipt requires a verified JAM acknowledgment. Inspect the session then requeue or abandon.",
				);
			const result = this.db
				.prepare(
					"UPDATE intake SET state=?, reason=NULL WHERE delivery=? AND state='review'",
				)
				.run(states[decision]!, delivery);
			if (result.changes !== 1)
				throw new Error("Delivery is not awaiting review");
			this.db
				.prepare("UPDATE topic SET established=?")
				.run(Number(session === "resume"));
			this.db
				.prepare(
					"INSERT INTO resolutions(delivery,operator,decision,session_state) VALUES(?,?,?,?)",
				)
				.run(delivery, operator, decision, session);
		});
	}

	resolveWorker(delivery: string, decision: string, operator: string) {
		if (!["complete", "abandon"].includes(decision) || !operator.trim())
			throw new Error("Expected complete or abandon and an operator");
		this.transaction(() => {
			const result = this.db
				.prepare(
					"UPDATE intake SET workerState=? WHERE delivery=? AND workerState='review'",
				)
				.run(decision, delivery);
			if (result.changes !== 1)
				throw new Error("No ambiguous worker dispatch for this delivery");
			this.db
				.prepare(
					"INSERT INTO resolutions(delivery,operator,decision,session_state) VALUES(?,?,?,?)",
				)
				.run(delivery, operator, decision, "worker");
		});
	}
}
