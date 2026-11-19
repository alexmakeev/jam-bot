import type { DatabaseSync } from "node:sqlite";

export interface NativeWorkerIntent {
	delivery: string;
	issue: number;
	role: "assignment" | "developer" | "architect" | "consultant" | "integrator";
	challenge: string;
	inputDigest: string;
	approvalDigest: string;
	revision: string;
	files: readonly string[];
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const head = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const roles = new Set([
	"assignment",
	"developer",
	"architect",
	"consultant",
	"integrator",
]);

export class NativeRoleDeferred extends Error {
	constructor(readonly intent: NativeWorkerIntent) {
		super("Native worker awaits its original dispatch");
	}
}

export function nativeWorkerAuthority(intent: NativeWorkerIntent) {
	const {
		delivery,
		issue,
		role,
		challenge,
		inputDigest,
		approvalDigest,
		revision,
		files,
	} = intent;
	if (
		!uuid.test(delivery) ||
		!uuid.test(challenge) ||
		!Number.isSafeInteger(issue) ||
		issue < 1 ||
		!roles.has(role) ||
		!digest.test(inputDigest) ||
		!digest.test(approvalDigest) ||
		!head.test(revision) ||
		!files.length ||
		files.length > 32 ||
		new Set(files).size !== files.length ||
		files.some(
			(path) =>
				!path ||
				path.includes("\\") ||
				path.includes("\0") ||
				path
					.split("/")
					.some((segment) => !segment || segment === "." || segment === ".."),
		)
	)
		throw Error("Native worker intent lacks exact authority or scope");
	return JSON.stringify({
		delivery,
		issue,
		role,
		challenge,
		inputDigest,
		approvalDigest,
		revision,
		files: [...files].sort(),
	});
}

export class NativeWorkerWaits {
	constructor(private readonly db: DatabaseSync) {
		db.exec(`CREATE TABLE IF NOT EXISTS native_worker_waits(
			delivery TEXT PRIMARY KEY,issue INTEGER NOT NULL UNIQUE,challenge TEXT NOT NULL UNIQUE,
			intent TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0)`);
	}
	private write<T>(operation: () => T) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private assertOriginal(intent: NativeWorkerIntent) {
		const intentString = nativeWorkerAuthority(intent);
		const saved = this.db
			.prepare(
				"SELECT intent FROM native_worker_waits WHERE delivery=? AND challenge=?",
			)
			.get(intent.delivery, intent.challenge);
		if (saved?.intent !== intentString)
			throw Error("Native worker dispatch differs from its durable intent");
	}
	canAdmit(files: readonly string[]) {
		const others = this.db
			.prepare("SELECT intent FROM native_worker_waits")
			.all();
		const advice = this.db
			.prepare(`SELECT w.snapshot FROM intake i LEFT JOIN worker_advice_waits w ON i.delivery=w.delivery
				WHERE i.workerState='waiting-advice'`)
			.all();
		return (
			files.length > 0 &&
			others.length + advice.length < 2 &&
			advice.every((row) => {
				if (typeof row.snapshot !== "string") return false;
				const previous = JSON.parse(row.snapshot) as { files?: string[] };
				return (
					Array.isArray(previous.files) &&
					!previous.files.some((path) => files.includes(path))
				);
			}) &&
			!others.some((row) => {
				const original = JSON.parse(String(row.intent)) as NativeWorkerIntent;
				return original.files.some((path) => files.includes(path));
			})
		);
	}
	park(intent: NativeWorkerIntent) {
		const encoded = nativeWorkerAuthority(intent);
		this.write(() => {
			if (!this.canAdmit(intent.files))
				throw Error("Native worker would exceed its topic scope");
			const moved = this.db
				.prepare(`UPDATE intake SET workerState='waiting-native'
				WHERE delivery=? AND issue=? AND workerState='running' AND specCheckpoint IS NOT NULL
				AND NOT EXISTS(SELECT 1 FROM intake WHERE state IN ('running','review') OR workerState='review')`)
				.run(intent.delivery, intent.issue);
			if (moved.changes !== 1)
				throw Error("Native worker does not own a durable stage");
			this.db
				.prepare(
					"INSERT INTO native_worker_waits(delivery,issue,challenge,intent) VALUES(?,?,?,?)",
				)
				.run(intent.delivery, intent.issue, intent.challenge, encoded);
		});
	}
	recordVerifiedReply(intent: NativeWorkerIntent) {
		const recorded = this.db
			.prepare(
				"UPDATE native_worker_waits SET ready=1 WHERE delivery=? AND challenge=? AND intent=?",
			)
			.run(intent.delivery, intent.challenge, nativeWorkerAuthority(intent));
		if (recorded.changes !== 1)
			throw Error("Native worker dispatch differs from its durable intent");
	}
	resume(intent: NativeWorkerIntent) {
		return this.write(() => {
			this.assertOriginal(intent);
			const moved = this.db
				.prepare(`UPDATE intake SET workerState='running' WHERE delivery=? AND issue=? AND workerState='waiting-native'
				AND EXISTS(SELECT 1 FROM native_worker_waits WHERE delivery=? AND challenge=? AND ready=1)
				AND NOT EXISTS(SELECT 1 FROM intake WHERE state IN ('running','review') OR workerState IN ('running','review'))`)
				.run(intent.delivery, intent.issue, intent.delivery, intent.challenge);
			return moved.changes === 1;
		});
	}
	reconcileParkedStage(intent: NativeWorkerIntent) {
		return this.write(() => {
			this.assertOriginal(intent);
			return (
				this.db
					.prepare(`UPDATE intake SET workerState='waiting-native'
				WHERE delivery=? AND issue=? AND workerState='pending' AND specCheckpoint IS NOT NULL
				AND NOT EXISTS(SELECT 1 FROM intake WHERE workerState='running' OR state='running')`)
					.run(intent.delivery, intent.issue).changes === 1
			);
		});
	}
	finishEffect(intent: NativeWorkerIntent) {
		this.assertOriginal(intent);
		const removed = this.db
			.prepare(`DELETE FROM native_worker_waits WHERE delivery=? AND challenge=? AND ready=1
			AND EXISTS(SELECT 1 FROM intake WHERE delivery=? AND workerState='running')
			AND NOT EXISTS(SELECT 1 FROM intake WHERE state IN ('running','review') OR workerState='review')`)
			.run(intent.delivery, intent.challenge, intent.delivery);
		if (removed.changes !== 1)
			throw Error("Native worker cannot release an unowned continuation");
	}
}
