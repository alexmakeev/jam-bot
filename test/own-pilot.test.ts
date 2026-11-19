import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskAdmission } from "../src/task-admission.js";
import { openTopic } from "../src/topics.js";
import { verifyOwnPilotJournal } from "../src/own-pilot.js";

test("the configured pilot rejects a second card before authorization and across restart", async (t) => {
	const previous = process.env.JAM_OWN_PILOT_ISSUE;
	process.env.JAM_OWN_PILOT_ISSUE = "41";
	const dir = await mkdtemp(join(tmpdir(), "jam-own-pilot-"));
	t.after(async () => {
		if (previous === undefined) delete process.env.JAM_OWN_PILOT_ISSUE;
		else process.env.JAM_OWN_PILOT_ISSUE = previous;
		await rm(dir, { recursive: true, force: true });
	});
	const topic = {
		repository: "alexmakeev/jam-bot",
		repoId: 1456661011,
		installation: 181780749,
		cwd: join(dir, "leo"),
	};
	const row = {
		delivery: "fixture-first",
		issue: 41,
		action: "task" as const,
		title: "First",
		body: "One authorized card",
		approvalSource: "typed" as const,
		typeId: 7,
		actorId: 8,
		authorId: 8,
		actorLogin: "fixture",
		authorLogin: "fixture",
	};
	const second = { ...row, delivery: "fixture-other", issue: 42 };
	let approvals = 0;
	const admissions = new TaskAdmission(async () => {
		approvals++;
	});
	const first = await openTopic(dir, topic);
	try {
		verifyOwnPilotJournal(first);
		assert.equal(await admissions.admit(first, second), 409);
		assert.equal(await admissions.admit(first, row), 202);
		assert.equal(await admissions.admit(first, row), 202);
		assert.equal(approvals, 1);
	} finally {
		first.journal.db.close();
	}
	const restarted = await openTopic(dir, topic);
	try {
		verifyOwnPilotJournal(restarted);
		assert.equal(await admissions.admit(restarted, second), 409);
		assert.equal(restarted.journal.list().length, 1);
		process.env.JAM_OWN_PILOT_ISSUE = "42";
		assert.throws(() => verifyOwnPilotJournal(restarted), /bound/);
	} finally {
		restarted.journal.db.close();
	}
});
