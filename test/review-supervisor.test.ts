import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	mandatoryReview,
	type MandatoryReview,
} from "../src/review-supervisor.js";
import {
	prepareReviewNotices,
	queueReviewNotice,
	publishReviewNotice,
} from "../src/review-escalation.js";

import { atomicJson } from "../src/storage.js";

const answer = {
	developer: "member",
	nativeMember: "reviewer@team",
	backend: "in-process",
	team: "team",
	output: "PASS\nChecked.",
};
const noop = async () => {};
async function project(
	t: import("node:test").TestContext,
): Promise<MandatoryReview> {
	const state = await mkdtemp(join(tmpdir(), "jam-review-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	return {
		state,
		cwd: state,
		session: "lead",
		issue: 21,
		issues: [21],
		revision: "a".repeat(40),
		role: "consultant",
		input: "immutable original",
		signal: new AbortController().signal,
	};
}
test("late original receipt completes a timed-out review without a second reviewer", async (t) => {
	const job = await project(t);
	let calls = 0;
	const value = await mandatoryReview(job, noop, {
		run: async () => {
			calls++;
			throw Error("Native teammate receipt timed out");
		},
		observe: async () => ({ receipt: answer }),
		graceMs: 0,
		pause: noop,
	});
	assert.equal(value.output, answer.output);
	assert.equal(calls, 1);
});
test("retry only the missing review once, retain the input, and replay the verified receipt", async (t) => {
	const job = await project(t);
	let calls = 0;
	const challenges = new Set();
	const deps = {
		run: async (request: { input: string }, identity?: string) => {
			assert.equal(request.input, job.input);
			challenges.add(identity);
			if (++calls === 1)
				throw Error("Native teammate runtime exited before verified receipt");
			return answer;
		},
		observe: async () => ({}),
		graceMs: 0,
		pause: noop,
	};
	assert.equal((await mandatoryReview(job, noop, deps)).output, answer.output);
	assert.equal(
		(
			await mandatoryReview(
				{ ...job, input: "changed ephemeral report" },
				noop,
				deps,
			)
		).output,
		answer.output,
	);
	assert.equal(calls, 2);
	assert.equal(challenges.size, 2);
});
test("explicit safety refusal persists across restart and never resubmits the payload", async (t) => {
	const job = await project(t);
	let calls = 0,
		alerts = 0;
	const deps = {
		run: async () => {
			calls++;
			throw Error(
				"Native model refused this stage; preserve the candidate and reconcile before further work",
			);
		},
		observe: async () => ({}),
		graceMs: 0,
		pause: noop,
	};
	for (let i = 0; i < 2; i++)
		await assert.rejects(
			mandatoryReview(
				job,
				async () => {
					alerts++;
				},
				deps,
			),
			/refused/,
		);
	await assert.rejects(
		mandatoryReview(
			{ ...job, evidenceRound: 1, input: "updated evidence" },
			async () => {
				alerts++;
			},
			deps,
		),
		/refused/,
	);
	assert.equal(calls, 1);
	assert.equal(alerts, 3);
});
test("restart reconciles an interrupted attempt and escalates unresolved ownership without starting another", async (t) => {
	const job = await project(t),
		stop = new AbortController();
	let calls = 0;
	await assert.rejects(
		mandatoryReview({ ...job, signal: stop.signal }, noop, {
			run: async () => {
				calls++;
				stop.abort();
				throw Error("interrupted");
			},
			observe: async () => ({}),
			graceMs: 0,
			pause: noop,
		}),
	);
	await assert.rejects(
		mandatoryReview(job, noop, {
			run: async () => {
				calls++;
				return answer;
			},
			observe: async () => ({ live: true }),
			graceMs: 0,
			pause: noop,
		}),
		/still be active/,
	);
	assert.equal(calls, 1);
});
test("authenticated issue notice survives ambiguous creation, pagination and spoofed markers", async () => {
	const db = new DatabaseSync(":memory:");
	prepareReviewNotices(db);
	const revision = "b".repeat(40);
	queueReviewNotice(db, 21, revision, "consultant", "Model refused");
	queueReviewNotice(db, 21, revision, "consultant", "Model refused");
	const row = db.prepare("select * from review_escalations").get()!;
	const notice = {
		issue: 21,
		revision,
		role: "consultant" as const,
		reason: "Model refused",
		diagnosis: "Please revise the scope.",
		challenge: null,
		remote: null,
		attempts: 0,
	};
	assert.equal(row.issue, 21);
	assert.equal(
		db.prepare("select count(*) as n from review_escalations").get()?.n,
		1,
	);
	db.close();
	const marker =
		"<!-- jam-bot:mandatory-review:consultant:" + revision + " -->";
	const history: { id: number; body: string; user: { id: number } }[] =
		Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			body: marker,
			user: { id: 2 },
		}));
	let posts = 0;
	const api = async (path: string, method?: string, body?: object) => {
		if (method === "POST") {
			posts++;
			history.push({
				id: 200,
				body: (body as { body: string }).body,
				user: { id: 42 },
			});
			throw Error("Connection lost after create");
		}
		const page = Number(
			new URL("https://test" + path).searchParams.get("page"),
		);
		return history.slice(100 * (page - 1), 100 * page);
	};
	await assert.rejects(publishReviewNotice(api, 42, notice, "owner"));
	assert.equal(await publishReviewNotice(api, 42, notice, "owner"), 200);
	assert.equal(posts, 1);
	assert.match(history.at(-1)!.body, /@owner.*required PASS is missing/);
});

test("an explicit evidence correction gets a fresh review of the same code revision and replays once", async (t) => {
	const job = await project(t);
	let calls = 0;
	const deps = {
		run: async () => {
			calls++;
			return {
				...answer,
				output:
					calls === 1
						? "FAIL\nMissing test metadata."
						: "PASS\nEvidence complete.",
			};
		},
		observe: async () => ({}),
		graceMs: 0,
		pause: noop,
	};
	assert.match((await mandatoryReview(job, noop, deps)).output, /^FAIL/);
	const corrected = {
		...job,
		input: "same code with complete test metadata",
		evidenceRound: 1,
	};
	assert.match((await mandatoryReview(corrected, noop, deps)).output, /^PASS/);
	assert.match((await mandatoryReview(corrected, noop, deps)).output, /^PASS/);
	assert.equal(calls, 2);
});

test("a cached mandatory verdict cannot hide an automatic refusal fallback", async (t) => {
	const job = await project(t),
		config = join(job.state, "config"),
		previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = config;
	t.after(() => {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	});
	const startedAt = Date.now() - 1000,
		challenge = "00000000-0000-4000-8000-000000000001";
	const path = join(
		job.state,
		"mandatory-reviews",
		"consultant-21-" + job.revision + ".json",
	);
	await atomicJson(path, {
		session: job.session,
		issues: job.issues,
		revision: job.revision,
		role: job.role,
		input: job.input,
		attempts: [{ challenge, startedAt }],
		receipt: answer,
	});
	const log = join(config, "projects", job.cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
	await mkdir(log, { recursive: true });
	await writeFile(
		join(log, "lead.jsonl"),
		JSON.stringify({
			type: "system",
			subtype: "model_refusal_fallback",
			sessionId: job.session,
			timestamp: new Date().toISOString(),
		}) + "\n",
	);
	let alerts = 0;
	await assert.rejects(
		mandatoryReview(
			job,
			async () => {
				alerts++;
			},
			{
				run: async () => assert.fail("No replacement review"),
				observe: async () => assert.fail("No model recovery dispatch"),
				graceMs: 0,
				pause: noop,
			},
		),
		/native model refused/,
	);
	assert.equal(alerts, 1);
	assert.match(
		JSON.parse(await readFile(path, "utf8")).failure,
		/native model refused/,
	);
});

test("a cached mandatory review retains its producing attempt and rejects an incomplete blocker", async (t) => {
	const job = await project(t);
	const path = join(
		job.state,
		"mandatory-reviews",
		"consultant-21-" + job.revision + ".json",
	);
	const record = {
		session: job.session,
		issues: job.issues,
		revision: job.revision,
		role: job.role,
		input: job.input,
	};
	const deps = {
		run: async () => assert.fail("No replacement review"),
		observe: async () => assert.fail("No recovery dispatch"),
		graceMs: 0,
		pause: noop,
	};
	await atomicJson(path, { ...record, attempts: [], receipt: answer });
	await assert.rejects(
		mandatoryReview(job, noop, deps),
		/no producing attempt/,
	);
	const attempts = [
		{
			challenge: "00000000-0000-4000-8000-000000000001",
			startedAt: Date.now(),
		},
	];
	await atomicJson(path, {
		...record,
		attempts,
		receipt: { ...answer, output: "Blocked:\nWorkspace unavailable" },
	});
	await assert.rejects(mandatoryReview(job, noop, deps), /could not complete/);
});
