import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export const runObservationFile = "run-observations.sqlite";
export const timingKinds = [
	"supervisor-turn",
	"executor-turn",
	"waiting-tool",
	"model-request",
	"native-startup",
	"native-ack",
	"native-receipt",
	"workspace-read",
	"retry",
	"idle",
	"blocked",
	"recovery",
	"validation",
	"worker",
	"integration",
] as const;
export type TimingKind = (typeof timingKinds)[number];
const outcomes = [
	"finished",
	"error",
	"auth-failed",
	"refused",
	"timeout",
	"interrupted",
	"cancelled",
] as const;
const processStates = ["alive", "exited", "unknown"] as const;
type Outcome = (typeof outcomes)[number];
type Liveness = (typeof processStates)[number];
interface Clock {
	wall(): number;
	mono(): number;
}
const processClock: Clock = {
	wall: Date.now,
	mono: () => Math.floor(performance.now()),
};
const spanLimit = 512;
const heartbeatMs = 10_000;
const generatedId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Point = { utcMs: number; monoMs: number };

export function prepareRunObservations(db: DatabaseSync) {
	db.exec(`PRAGMA busy_timeout=8;
		CREATE TABLE IF NOT EXISTS timing_runs(id TEXT PRIMARY KEY,issue INTEGER,writer TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS timing_generations(
			id TEXT PRIMARY KEY,run TEXT NOT NULL,previous TEXT,pid INTEGER,
			startWall INTEGER NOT NULL,startMono INTEGER NOT NULL,lastWall INTEGER NOT NULL,lastMono INTEGER NOT NULL,
			liveness TEXT NOT NULL,outcome TEXT,clockJump INTEGER NOT NULL DEFAULT 0,dropped INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS timing_spans(
			id TEXT PRIMARY KEY,run TEXT NOT NULL,generation TEXT NOT NULL,parent TEXT,kind TEXT NOT NULL,
			startWall INTEGER NOT NULL,startMono INTEGER NOT NULL,endWall INTEGER,endMono INTEGER,outcome TEXT,apiMs INTEGER);
		CREATE INDEX IF NOT EXISTS timing_span_scope ON timing_spans(run,generation);
		CREATE INDEX IF NOT EXISTS timing_issue_scope ON timing_runs(issue);
	`);
}

interface RunOptions {
	issue?: number;
	previous?: { run: string; generation: string };
	pid?: number;
	clock?: Clock;
}

export class RunObservation {
	readonly run: string;
	readonly generation = randomUUID();
	private lastHeartbeat: number;
	private readonly clock: Clock;
	constructor(
		private readonly db: DatabaseSync,
		options: RunOptions = {},
	) {
		const { issue, previous, pid, clock = processClock } = options;
		if (issue !== undefined && (!Number.isSafeInteger(issue) || issue < 1))
			throw Error("Invalid timing issue");
		if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1))
			throw Error("Invalid observed process");
		if (
			previous &&
			(!generatedId.test(previous.run) ||
				!generatedId.test(previous.generation))
		)
			throw Error("Invalid timing generation");
		this.clock = clock;
		this.run = previous?.run ?? randomUUID();
		const now = this.point();
		this.lastHeartbeat = now.monoMs;
		db.exec("BEGIN IMMEDIATE");
		try {
			if (previous) {
				const claimed = db
					.prepare(
						"UPDATE timing_runs SET writer=? WHERE id=? AND writer=? AND issue IS ?",
					)
					.run(this.generation, this.run, previous.generation, issue ?? null);
				if (claimed.changes !== 1) throw Error("Timing generation changed");
			} else
				db.prepare("INSERT INTO timing_runs VALUES(?,?,?)").run(
					this.run,
					issue ?? null,
					this.generation,
				);
			db.prepare(`INSERT INTO timing_generations(id,run,previous,pid,startWall,startMono,lastWall,lastMono,liveness)
				VALUES(?,?,?,?,?,?,?,?,?)`).run(
				this.generation,
				this.run,
				previous?.generation ?? null,
				pid ?? null,
				now.utcMs,
				now.monoMs,
				now.utcMs,
				now.monoMs,
				pid ? "alive" : "unknown",
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	private point(): Point {
		return { utcMs: this.clock.wall(), monoMs: this.clock.mono() };
	}
	private owned() {
		return Boolean(
			this.db
				.prepare(`SELECT 1 FROM timing_runs r JOIN timing_generations g ON g.id=r.writer
			WHERE r.id=? AND g.id=? AND g.outcome IS NULL`)
				.get(this.run, this.generation),
		);
	}
	private watermark(
		now: Point,
		liveness?: Liveness,
		outcome?: Outcome,
		dropped = 0,
	) {
		return (
			this.db
				.prepare(`UPDATE timing_generations SET lastWall=?,lastMono=?,liveness=COALESCE(?,liveness),
			outcome=COALESCE(?,outcome),clockJump=MAX(clockJump,abs((?-lastWall)-(?-lastMono))>2000),dropped=dropped+?
			WHERE id=? AND outcome IS NULL AND lastMono<=? AND id=(SELECT writer FROM timing_runs WHERE id=?)`)
				.run(
					now.utcMs,
					now.monoMs,
					liveness ?? null,
					outcome ?? null,
					now.utcMs,
					now.monoMs,
					dropped,
					this.generation,
					now.monoMs,
					this.run,
				).changes === 1
		);
	}

	begin(kind: TimingKind, parent?: string) {
		if (!timingKinds.includes(kind) || (parent && !generatedId.test(parent)))
			throw Error("Invalid timing span");
		if (!this.owned()) return;
		if (
			parent &&
			!this.db
				.prepare("SELECT 1 FROM timing_spans WHERE id=? AND generation=?")
				.get(parent, this.generation)
		)
			throw Error("Timing span parent differs from its generation");
		const now = this.point(),
			id = randomUUID();
		const opened = this.db
			.prepare(`INSERT INTO timing_spans(id,run,generation,parent,kind,startWall,startMono)
			SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM timing_spans WHERE run=?)<?
			AND ?=(SELECT writer FROM timing_runs WHERE id=?)`)
			.run(
				id,
				this.run,
				this.generation,
				parent ?? null,
				kind,
				now.utcMs,
				now.monoMs,
				this.run,
				spanLimit,
				this.generation,
				this.run,
			);
		this.watermark(now, undefined, undefined, opened.changes === 1 ? 0 : 1);
		if (opened.changes === 1) return id;
	}

	end(span: string, outcome: Outcome, apiMs?: number) {
		if (
			!generatedId.test(span) ||
			!outcomes.includes(outcome) ||
			(apiMs !== undefined && (!Number.isSafeInteger(apiMs) || apiMs < 0))
		)
			throw Error("Invalid timing completion");
		if (!this.owned()) return false;
		const now = this.point();
		const ended =
			this.db
				.prepare(`UPDATE timing_spans SET endWall=?,endMono=?,outcome=?,apiMs=?
			WHERE id=? AND generation=? AND endMono IS NULL AND startMono<=?
			AND generation=(SELECT writer FROM timing_runs WHERE id=?)`)
				.run(
					now.utcMs,
					now.monoMs,
					outcome,
					apiMs ?? null,
					span,
					this.generation,
					now.monoMs,
					this.run,
				).changes === 1;
		if (ended) this.watermark(now);
		return ended;
	}

	heartbeat(liveness: Liveness) {
		if (!processStates.includes(liveness))
			throw Error("Invalid process observation");
		const now = this.point();
		if (now.monoMs - this.lastHeartbeat < heartbeatMs) return this.owned();
		const written = this.watermark(now, liveness);
		if (written) this.lastHeartbeat = now.monoMs;
		return written;
	}

	finish(outcome: Outcome, liveness: Liveness) {
		if (!outcomes.includes(outcome) || !processStates.includes(liveness))
			throw Error("Invalid run outcome");
		return this.watermark(this.point(), liveness, outcome);
	}
}

export function unionMilliseconds(windows: [number, number][]) {
	let total = 0,
		end = 0;
	for (const [lo, hi] of windows
		.filter(([lo, hi]) => hi > lo)
		.sort((a, b) => a[0] - b[0])) {
		total += Math.max(0, hi - Math.max(lo, end));
		end = Math.max(end, hi);
	}
	return total;
}

export function readRunObservations(
	db: DatabaseSync,
	issue: number | undefined,
	run: string | undefined,
	offset: number,
	limit: number,
	now = Date.now(),
): { data: Record<string, SQLOutputValue>[]; next: number | null } {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='timing_runs'").get())
		return { data: [], next: null };
	if (run) {
		const rows = db
			.prepare(`SELECT s.rowid AS seq,s.id,s.parent,s.generation,s.kind,s.startWall,s.endWall,s.startMono,s.endMono,
			s.outcome,s.apiMs FROM timing_spans s JOIN timing_runs r ON s.run=r.id
			WHERE r.id=? AND (? IS NULL OR r.issue=?) AND s.rowid>? ORDER BY s.rowid LIMIT ?`)
			.all(run, issue ?? null, issue ?? null, offset, limit + 1);
		const data = rows.slice(0, limit);
		return {
			data,
			next: rows.length > limit ? Number(data.at(-1)?.seq) : null,
		};
	}
	const summaries = db
		.prepare(`SELECT r.id,r.issue,r.writer AS currentGeneration,g.id AS generation,g.previous,g.startWall,g.startMono,
		g.lastWall,g.lastMono,g.liveness,g.outcome,g.dropped,g.clockJump FROM timing_generations g JOIN timing_runs r ON g.run=r.id
		WHERE (? IS NULL OR r.issue=?) ORDER BY g.rowid DESC LIMIT ? OFFSET ?`)
		.all(issue ?? null, issue ?? null, limit + 1, offset);
	const data = summaries.slice(0, limit).map((row) => {
		const start = Number(row.startMono),
			last = Number(row.lastMono);
		const spans = db
			.prepare(
				"SELECT startMono,endMono FROM timing_spans WHERE generation=? AND kind NOT IN ('executor-turn','supervisor-turn')",
			)
			.all(row.generation!);
		const observedMs = Math.max(0, last - start);
		const phaseMs = unionMilliseconds(
			spans.map((span) => [
				Math.max(start, Number(span.startMono)),
				Math.min(last, Number(span.endMono ?? last)),
			]),
		);
		return {
			...row,
			observedMs,
			phaseMs,
			unclassifiedMs: observedMs - phaseMs,
			observer: row.outcome
				? "terminal"
				: row.currentGeneration !== row.generation
					? "replaced"
					: row.clockJump || now < Number(row.lastWall)
						? "unknown"
						: now - Number(row.lastWall) > 30_000
							? "stale"
							: "fresh",
		};
	});
	return { data, next: summaries.length > limit ? offset + limit : null };
}

export async function observeTopicStep<T>(
	state: string,
	issue: number,
	kind: TimingKind,
	work: () => Promise<T>,
	enabled = process.env.JAM_RUN_OBSERVATIONS === "1",
): Promise<T> {
	if (!enabled) return work();
	const { DatabaseSync } = await import("node:sqlite");
	const { join } = await import("node:path");
	const { lstatSync } = await import("node:fs");
	const path = join(state, runObservationFile);
	let db: DatabaseSync | undefined;
	let run: RunObservation | undefined;
	let span: string | undefined;
	try {
		const file = lstatSync(path, { throwIfNoEntry: false });
		if (file && !file.isFile()) return work();
		db = new DatabaseSync(path);
		prepareRunObservations(db);
		run = new RunObservation(db, { issue, pid: process.pid });
		span = run.begin(kind);
	} catch {
		try {
			db?.close();
		} catch {}
		return work();
	}
	const timer = setInterval(() => {
		try {
			run?.heartbeat("alive");
		} catch {}
	}, heartbeatMs);
	timer.unref();
	let outcome: Outcome = "finished";
	try {
		return await work();
	} catch (error) {
		outcome = "error";
		throw error;
	} finally {
		clearInterval(timer);
		try {
			if (span) run.end(span, outcome);
			run.finish(outcome, "alive");
		} catch {}
		try {
			db.close();
		} catch {}
	}
}
