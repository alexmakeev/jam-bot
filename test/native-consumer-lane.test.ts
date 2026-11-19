import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal, type Intake } from "../src/intake-journal.js";
import {
	NativeConsumerLane,
	type NativeConsumerTransport,
} from "../src/native-consumer-lane.js";
import {
	NativeRoleDeferred,
	nativeWorkerOwnsParkedStage,
	type NativeWorkerIntent,
} from "../src/native-worker-wait.js";
import { checkpointRole } from "../src/role-checkpoint.js";
import type { RoleStage } from "../src/role-harness.js";
import { atomicJson } from "../src/storage.js";
import { consume } from "../src/webhook-service.js";

const receipt = {
	developer: "original",
	nativeMember: "manager-1@fixture",
	backend: "in-process" as const,
	team: "fixture",
	output: "One approved work product",
};

test("capacity-one role adapter parks ordinary work and preserves stage parity after journal reopen", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-native-consumer-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const topic = {
		repository: "test/fixture",
		repoId: 100,
		installation: 200,
		cwd: state,
	};
	const task: Intake = {
		delivery: randomUUID(),
		issue: 1,
		action: "task",
		title: "Approved Development",
		body: "Return one ordinary work product.",
		kind: "development",
		actorId: 30,
		actorLogin: "owner",
		authorId: 30,
		authorLogin: "owner",
		typeId: 50,
		approvalSource: "typed",
	};
	const path = join(state, "intake.sqlite");
	const journal = new Journal(path);
	journal.start(topic);
	journal.enqueue(task);
	assert.equal(journal.next()?.delivery, task.delivery);
	journal.complete({
		issue: task.issue,
		delivery: task.delivery,
		disposition: "intake_received",
	});
	assert.equal(
		journal.nextWorker(undefined, () => true)?.delivery,
		task.delivery,
	);
	const manifest = join(state, "workspace.json");
	await atomicJson(manifest, {
		version: 1,
		identity: { revision: "a".repeat(40), specifications: "b".repeat(64) },
		roots: { repository: state, specifications: state },
	});
	const job: RoleStage = {
		state,
		cwd: state,
		session: journal.lead().id,
		issue: 1,
		role: "developer",
		input: "Return the approved work product.",
		workspaceManifest: manifest,
		signal: new AbortController().signal,
	};
	const baseline = await checkpointRole(
		{ ...job, state: join(state, "legacy") },
		"continue",
		async () => receipt,
	);
	let intent: NativeWorkerIntent | undefined;
	let starts = 0,
		authChecks = 0,
		closes = 0;
	let verified = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const transport: NativeConsumerTransport = {
		occupied: async () => false,
		recover: async (_state, issue, challenge, expected) =>
			issue === 1 &&
			challenge === intent?.challenge &&
			expected?.approvalDigest === intent.approvalDigest
				? verified
					? { attempted: true, receipt }
					: { attempted: true }
				: undefined,
		start: async () => ({
			startRole: async (loaded, original, authorize) => {
				starts++;
				assert.equal(loaded.input, job.input);
				assert.equal(nativeWorkerOwnsParkedStage(journal.db, original), true);
				await authorize();
				intent = original;
				const acknowledgement = Promise.resolve({
					session: "fixture",
					member: "manager-1",
					handle: "original",
					challenge: original.challenge,
					promptId: "prompt",
				});
				return {
					acknowledgement,
					completion: gate.then(() => {
						verified = true;
						return receipt;
					}),
				};
			},
			close: async () => {
				closes++;
			},
		}),
	};
	const scope = ["src/example.ts"];
	const lane = new NativeConsumerLane({ topic, state, journal }, transport);
	const stage = lane.stage(task, scope);
	assert.ok(stage);
	try {
		await checkpointRole(job, "continue", stage.run, stage.recover);
		assert.fail("Stage should yield at an exact checkpoint");
	} catch (error) {
		assert.ok(error instanceof NativeRoleDeferred);
		lane.park(task, error, async () => {
			authChecks++;
		});
	}
	assert.equal(lane.busy(), true);
	assert.equal(lane.resume(), undefined);
	assert.equal(journal.nextWorker(), undefined);
	release();
	await lane.settle();
	assert.equal(closes, 1);
	journal.db.close();

	const reopened = new Journal(path);
	t.after(() => reopened.db.close());
	reopened.start(topic);
	const recovery = new NativeConsumerLane(
		{ topic, state, journal: reopened },
		transport,
	);
	await recovery.harvest();
	assert.equal(reopened.list()[0]?.workerState, "waiting-native");
	assert.equal(recovery.resume()?.delivery, task.delivery);
	const restored = recovery.stage(task, scope);
	assert.ok(restored);
	const outcome = await checkpointRole(
		job,
		"continue",
		restored.run,
		restored.recover,
	);
	assert.equal(outcome.output, baseline.output);
	assert.equal(outcome.developer, baseline.developer);
	recovery.finish(task);
	reopened.finishWorker(task.delivery);
	assert.equal(reopened.list()[0]?.workerState, "complete");
	assert.deepEqual(
		{ starts, authChecks, closes },
		{ starts: 1, authChecks: 1, closes: 1 },
	);
});

test("the normal topic consumer accepts isolated opt-in without starting a provider on an idle topic", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-idle-consumer-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const journal = new Journal(join(state, "intake.sqlite"));
	t.after(() => journal.db.close());
	const topic = {
		repository: "test/fixture",
		repoId: 100,
		installation: 200,
		cwd: state,
	};
	journal.start(topic);
	const signal = AbortSignal.timeout(20);
	await consume({ state, topic, journal }, signal, {
		start: async () => assert.fail("No provider required"),
	});
	assert.deepEqual(journal.list(), []);
});
