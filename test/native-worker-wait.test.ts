import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "../src/intake-journal.js";
import {
	recoverPersistentDispatch,
	persistentNativeActor,
	reportsNativeAuthenticationFailure,
} from "../src/native-persistent-lead.js";
import { RoleStageFailure } from "../src/role-failure.js";
import { checkpointRole } from "../src/role-checkpoint.js";
import type { RoleStage } from "../src/role-harness.js";
import {
	NativeRoleDeferred,
	nativeWorkerAuthority,
	nativeWorkerOwnsParkedStage,
	NativeWorkerWaits,
	type NativeWorkerIntent,
} from "../src/native-worker-wait.js";
import { atomicJson } from "../src/storage.js";
import { fingerprint } from "../src/work-progress.js";

const intent = (issue: number, files: string[]): NativeWorkerIntent => ({
	delivery: randomUUID(),
	issue,
	role: "architect",
	challenge: randomUUID(),
	inputDigest: fingerprint("approved change"),
	approvalDigest: fingerprint("trusted actor"),
	revision: "a".repeat(40),
	files,
});

test("persistent roles keep one manager per card and separate independent review", () => {
	const manager = persistentNativeActor("assignment", 1);
	assert.deepEqual(persistentNativeActor("developer", 1), manager);
	assert.notDeepEqual(persistentNativeActor("developer", 2), manager);
	assert.deepEqual(
		persistentNativeActor("architect", 1),
		persistentNativeActor("integrator", 2),
	);
	assert.notDeepEqual(persistentNativeActor("consultant", 1), manager);
	assert.notDeepEqual(
		persistentNativeActor("consultant", 1),
		persistentNativeActor("architect", 1),
	);
});

test("native recovery requires the exact approval envelope and refuses an older unbound dispatch", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "native-dispatch-bound-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const authority = intent(5, ["src/example.ts"]);
	const { issue, challenge } = authority;
	const path = join(state, "native-persistent-dispatches", challenge + ".json");
	const request = "Challenge " + challenge;
	const dispatch = {
		version: 3,
		issue,
		challenge,
		request,
		prompt: "Send " + request,
		handle: "member",
		authority: nativeWorkerAuthority(authority),
		initial: {
			config: state,
			cwd: state,
			session: randomUUID(),
			challenge: randomUUID(),
			...persistentNativeActor(authority.role, authority.issue),
		},
	};
	await atomicJson(path, dispatch);
	await assert.rejects(
		recoverPersistentDispatch(state, issue, challenge),
		/approved checkpoint/,
	);
	await assert.rejects(
		recoverPersistentDispatch(state, issue, challenge, {
			...authority,
			revision: "b".repeat(40),
		}),
		/approved checkpoint/,
	);
	assert.deepEqual(
		await recoverPersistentDispatch(state, issue, challenge, authority),
		{ attempted: true },
	);
	await atomicJson(path, {
		...dispatch,
		initial: {
			...dispatch.initial,
			...persistentNativeActor("consultant", issue),
		},
	});
	await assert.rejects(
		recoverPersistentDispatch(state, issue, challenge, authority),
		/approved role/,
	);
	await atomicJson(path, { ...dispatch, version: 2, authority: undefined });
	await assert.rejects(
		recoverPersistentDispatch(state, issue, challenge, authority),
		/approved checkpoint/,
	);
	assert.deepEqual(await recoverPersistentDispatch(state, issue, challenge), {
		attempted: true,
	});
});

test("only an explicit native auth error from the observed lead stops startup", () => {
	const session = randomUUID();
	const error = {
		type: "assistant",
		sessionId: session,
		isApiErrorMessage: true,
		error: "authentication_failed",
	};
	assert.equal(reportsNativeAuthenticationFailure([error], session), true);
	for (const unrelated of [
		{ ...error, type: "user" },
		{ ...error, sessionId: randomUUID() },
		{ ...error, agentId: "another-member" },
		{ ...error, isApiErrorMessage: false },
		{ ...error, error: "refusal" },
	])
		assert.equal(
			reportsNativeAuthenticationFailure([unrelated], session),
			false,
		);
});

test("only the original verified disjoint stage can resume after process interruption", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "native-worker-wait-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "intake.sqlite");
	const topic = {
		repository: "test/example",
		repoId: 10,
		installation: 11,
		cwd: root,
	};
	const first = intent(1, ["src/first.ts"]);
	const second = intent(2, ["src/second.ts"]);
	const journal = new Journal(path);
	journal.start(topic);
	const waits = new NativeWorkerWaits(journal.db);
	const third = intent(3, ["src/third.ts"]);
	for (const job of [first, second, third]) {
		journal.db
			.prepare(
				"INSERT INTO intake(delivery,issue,action,title,body,state,workerState) VALUES(?,?,'task','','','received','pending')",
			)
			.run(job.delivery, job.issue);
	}
	assert.equal(
		journal.nextWorker(undefined, () => true)?.delivery,
		first.delivery,
	);
	waits.park(first);
	assert.equal(nativeWorkerOwnsParkedStage(journal.db, first), true);
	assert.equal(nativeWorkerOwnsParkedStage(journal.db, second), false);
	journal.db
		.prepare(
			"INSERT INTO intake(delivery,issue,action,title,body,state) VALUES(?,4,'opened','','','queued')",
		)
		.run(randomUUID());
	assert.equal(journal.next(), undefined);
	assert.equal(journal.nextWorker(), undefined);
	assert.deepEqual(journal.pendingWorkers(), []);
	assert.equal(waits.canAdmit([]), false);
	assert.equal(waits.canAdmit(first.files), false);
	assert.equal(waits.canAdmit(second.files), true);
	assert.equal(
		journal.nextWorker(
			undefined,
			() => true,
			() => waits.canAdmit(first.files),
		),
		undefined,
	);
	assert.equal(
		journal.nextWorker(
			undefined,
			() => true,
			(job) => job.delivery === second.delivery && waits.canAdmit(second.files),
		)?.delivery,
		second.delivery,
	);
	waits.park(second);
	assert.equal(waits.canAdmit(["src/third.ts"]), false);
	assert.equal(
		journal.nextWorker(
			undefined,
			() => true,
			() => true,
		),
		undefined,
	);
	assert.equal(waits.resume(first), false);
	assert.throws(
		() =>
			waits.recordVerifiedReply({
				...second,
				approvalDigest: first.inputDigest,
			}),
		/durable intent/,
	);
	waits.recordVerifiedReply(second);
	assert.equal(nativeWorkerOwnsParkedStage(journal.db, second), false);
	journal.db.prepare("UPDATE intake SET state='review' WHERE issue=4").run();
	assert.equal(waits.resume(second), false);
	journal.db.prepare("UPDATE intake SET state='queued' WHERE issue=4").run();
	assert.equal(waits.resume(second), true);
	journal.db.close();

	const recovered = new Journal(path);
	t.after(() => recovered.db.close());
	recovered.start(topic);
	const restored = new NativeWorkerWaits(recovered.db);
	assert.equal(restored.reconcileParkedStage(second), true);
	assert.equal(restored.resume(second), true);
	restored.recordVerifiedReply(first);
	assert.equal(restored.resume(first), false);
	assert.throws(() => restored.finishEffect(first), /unowned continuation/);
	restored.finishEffect(second);
	recovered.finishWorker(second.delivery);
	assert.equal(restored.resume(first), true);
	restored.finishEffect(first);
	recovered.finishWorker(first.delivery);
	assert.equal(restored.canAdmit(["src/third.ts"]), true);
});

test("an unseen deferred role never becomes a replacement dispatch", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "native-role-wait-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const original = intent(5, ["src/first.ts"]);
	const job = {
		state,
		cwd: state,
		session: randomUUID(),
		issue: 5,
		role: original.role,
		input: "approved change",
		signal: new AbortController().signal,
	};
	let sends = 0;
	const dispatch = async (_job: RoleStage, challenge?: string) => {
		sends++;
		assert.ok(challenge);
		throw new NativeRoleDeferred({ ...original, challenge });
	};
	const noReceipt = async () => ({ live: false });
	for (let i = 0; i < 2; i++)
		await assert.rejects(
			checkpointRole(job, "review change", dispatch, noReceipt),
			NativeRoleDeferred,
		);
	const receipt = {
		developer: "original-handle",
		nativeMember: "original@team",
		backend: "in-process",
		team: "team",
		output: "Verified stage product",
	};
	assert.equal(
		(
			await checkpointRole(job, "review change", dispatch, async () => ({
				receipt,
			}))
		).output,
		receipt.output,
	);
	await assert.rejects(
		checkpointRole(job, "review change", dispatch, noReceipt),
		NativeRoleDeferred,
	);
	await assert.rejects(
		checkpointRole(job, "review change", dispatch, async () => ({
			receipt: { ...receipt, output: "Altered" },
		})),
		/differs from its original verified outcome/,
	);
	await assert.rejects(
		checkpointRole(job, "review change", dispatch, async () => ({
			refused: true,
		})),
		RoleStageFailure,
	);
	assert.equal(sends, 1);
});
