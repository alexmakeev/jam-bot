import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Journal } from "../src/intake-journal.js";
import { diagnosticOperations } from "../src/management-diagnostics.js";
import {
	observeTopicStep,
	prepareRunObservations,
	readRunObservations,
	RunObservation,
	runObservationFile,
	unionMilliseconds,
} from "../src/run-observations.js";

test("overlapping spans report union coverage and keep confirmed API time separate", () => {
	const db = new DatabaseSync(":memory:");
	try {
		prepareRunObservations(db);
		let ms = 0;
		const run = new RunObservation(db, {
			issue: 1,
			clock: { mono: () => ms, wall: () => 100_000 + ms },
		});
		const parent = run.begin("executor-turn")!;
		const tool = run.begin("waiting-tool", parent)!;
		ms = 3;
		const model = run.begin("model-request", parent)!;
		ms = 10;
		assert.equal(run.end(tool, "finished"), true);
		assert.equal(run.end(tool, "finished"), false);
		ms = 13;
		run.end(model, "auth-failed", 7);
		ms = 16;
		run.end(parent, "finished");
		run.finish("finished", "exited");
		assert.equal(
			unionMilliseconds([
				[0, 10],
				[3, 13],
			]),
			13,
		);
		const summary = readRunObservations(db, 1, undefined, 0, 5, 100_016)
			.data[0]!;
		assert.equal(summary.observedMs, 16);
		assert.equal(summary.phaseMs, 13);
		assert.equal(summary.unclassifiedMs, 3);
		const spans = readRunObservations(db, 1, run.run, 0, 5).data;
		assert.equal(spans.find((span) => span.kind === "model-request")?.apiMs, 7);
		assert.equal(
			spans.find((span) => span.kind === "waiting-tool")?.apiMs,
			null,
		);
		assert.deepEqual(readRunObservations(db, 2, run.run, 0, 5).data, []);
	} finally {
		db.close();
	}
});

test("a killed child retains its last observed watermark and a replacement fences late writes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jam-run-observation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, runObservationFile);
	const oldDb = new DatabaseSync(path);
	t.after(() => oldDb.close());
	prepareRunObservations(oldDb);
	let mono = 0,
		wall = 100_000;
	const clock = { mono: () => mono, wall: () => wall };
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
		stdio: "ignore",
	});
	const exited = once(child, "exit");
	const older = new RunObservation(oldDb, { clock, issue: 2, pid: child.pid });
	const pending = older.begin("workspace-read")!;
	mono = 11_000;
	wall = 111_000;
	assert.equal(older.heartbeat("alive"), true);
	child.kill("SIGKILL");
	assert.deepEqual(await exited, [null, "SIGKILL"]);
	wall = 160_000;
	mono = 0;
	const reopened = new DatabaseSync(path);
	t.after(() => reopened.close());
	const replacement = new RunObservation(reopened, {
		issue: 2,
		clock,
		previous: { run: older.run, generation: older.generation },
	});
	mono = 20_000;
	assert.equal(older.end(pending, "finished"), false);
	assert.equal(older.heartbeat("exited"), false);
	const prior = readRunObservations(
		reopened,
		2,
		undefined,
		0,
		10,
		160_000,
	).data.find((row) => row.generation === older.generation);
	assert.equal(prior?.observer, "replaced");
	assert.equal(prior?.lastWall, 111_000);
	assert.equal(prior?.liveness, "alive");
	assert.equal(prior?.phaseMs, 11_000);
	const retry = replacement.begin("retry")!;
	mono += 250;
	wall += 250;
	assert.ok(replacement.end(retry, "cancelled"));
	const next = readRunObservations(reopened, 2, older.run, 1, 1).data[0]!;
	assert.equal(next.generation, replacement.generation);
});

test("a wall clock jump leaves monotonic coverage and explicit supervisor end separate", () => {
	const db = new DatabaseSync(":memory:");
	try {
		prepareRunObservations(db);
		let mono = 0,
			wall = 100_000;
		const run = new RunObservation(db, {
			clock: { mono: () => mono, wall: () => wall },
			pid: 99,
		});
		const supervisor = run.begin("supervisor-turn")!;
		const worker = run.begin("worker")!;
		mono = 300;
		wall = 99_000;
		run.end(supervisor, "finished");
		mono = 11_000;
		wall = 81_000;
		run.heartbeat("alive");
		const row = readRunObservations(db, undefined, undefined, 0, 1).data[0]!;
		assert.equal(row.observer, "unknown");
		assert.equal(row.outcome, null);
		assert.equal(row.liveness, "alive");
		assert.equal(row.phaseMs, 11_000);
		assert.ok(run.end(worker, "finished"));
	} finally {
		db.close();
	}
});

test("timing diagnostics stays in the authorized topic and preserves the cursor on byte trimming", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-timing-diagnostics-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const journal = new Journal(join(state, "intake.sqlite"));
	t.after(() => journal.db.close());
	const topic = {
		repository: "fixture/topic",
		repoId: 11,
		installation: 22,
		cwd: join(state, "leo"),
	};
	journal.start(topic);
	const db = new DatabaseSync(join(state, runObservationFile));
	t.after(() => db.close());
	prepareRunObservations(db);
	const run = new RunObservation(db, { issue: 8 });
	assert.throws(
		() => run.begin("credential CANARY" as never),
		/Invalid timing span/,
	);
	for (let index = 0; index < 8; index++) {
		const span = run.begin("native-receipt")!;
		run.end(span, "finished");
	}
	const op = diagnosticOperations(
		new Map([["22/11", { state, topic, journal }]]),
	)[0]!;
	const call = (raw: Record<string, unknown>) =>
		op.run(
			op.input.parse({
				serverId: "00000000-0000-4000-8000-000000000001",
				repoId: 11,
				view: "timing",
				runId: run.run,
				issue: 8,
				maxBytes: 600,
				...raw,
			}),
		);
	const visible = await call({});
	assert.ok(Buffer.byteLength(JSON.stringify(visible)) <= 600);
	assert.ok(!JSON.stringify(visible).includes("CANARY"));
	assert.ok(Number(visible.next) > 0);
	const next = await call({ offset: visible.next });
	assert.ok(
		Array.isArray(next.data) &&
			Number(next.data[0]?.seq) > Number(visible.next),
	);
	assert.deepEqual((await call({ issue: 9 })).data, []);
	await assert.rejects(call({ repoId: 12 }));
});

test("worker and nested parallel wait spans share one run and record parking as control flow", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-timing-worker-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const parked = Error("fixture parked");
	await assert.rejects(
		observeTopicStep(
			state,
			4,
			"worker",
			async () => {
				await Promise.all([
					observeTopicStep(state, 4, "native-receipt", async () => 1, true),
					observeTopicStep(state, 4, "waiting-tool", async () => 2, true),
				]);
				throw parked;
			},
			true,
			(error) => (error === parked ? "parked" : "error"),
		),
		parked,
	);
	const db = new DatabaseSync(join(state, runObservationFile), {
		readOnly: true,
	});
	t.after(() => db.close());
	const summary = readRunObservations(db, 4, undefined, 0, 5);
	assert.equal(summary.data.length, 1);
	assert.equal(summary.data[0]?.outcome, "parked");
	const root = db
		.prepare("SELECT id FROM timing_spans WHERE parent IS NULL")
		.get();
	assert.ok(root?.id);
	assert.equal(
		db
			.prepare("SELECT count(*) AS n FROM timing_spans WHERE parent=?")
			.get(root.id)?.n,
		2,
	);
	assert.equal(
		Number(summary.data[0]?.phaseMs) + Number(summary.data[0]?.unclassifiedMs),
		summary.data[0]?.observedMs,
	);
});

test("sidecar contention does not block or change the normal operation", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-timing-contention-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const db = new DatabaseSync(join(state, runObservationFile));
	t.after(() => db.close());
	prepareRunObservations(db);
	db.exec("BEGIN EXCLUSIVE");
	try {
		const begin = performance.now();
		assert.equal(
			await observeTopicStep(state, 4, "native-receipt", async () => 27, true),
			27,
		);
		assert.ok(performance.now() - begin < 1000);
	} finally {
		db.exec("ROLLBACK");
	}
});
