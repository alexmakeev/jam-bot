import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	adviserNotes,
	externalReview,
	reviewPacket,
} from "../src/external-advice.js";
import type { TaskApproval } from "../src/task-approval.js";
import type { Topic } from "../src/intake-journal.js";
import type { exchange } from "../src/profile-checkout.js";

const topic: Topic = {
	repoId: 21,
	repository: "example/project",
	installation: 42,
	cwd: "/unused",
};
const approval: TaskApproval = {
	actor: { id: 1, type: "User", login: "someone" },
	author: { id: 1, type: "User", login: "someone" },
	title: "Approved title",
	body: "Approved requirement",
	typeId: 12,
};
test("bounded evidence identifies omitted material and retains exact short values", () => {
	const full = '漢字"\n'.repeat(30000);
	const packet = reviewPacket(
		{ diff: full, issue: "7", test: "first\nsecond" },
		4096,
	);
	assert.ok(Buffer.byteLength(packet) <= 4096);
	assert.equal(JSON.parse(packet).test, "first\nsecond");
	assert.match(JSON.parse(packet).diff, /SHA-256 [0-9a-f]{64}/);
});
test("each original work card retains attributable adviser results and identical evidence reuses completed reviews", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jam-external-advice-"));
	const seen: number[] = [];
	let calls = 0;
	const broker: typeof exchange = async (_dir, request) => {
		calls++;
		assert.equal(request.phase, "diagnosis");
		assert.deepEqual(
			request.cards?.map((c) => c.issue),
			[2, 3],
		);
		assert.equal(JSON.parse(request.packet!).revision, "abcd");
		return {
			sha: "",
			advice: [
				{
					name: "primary",
					provider: "codex",
					status: "ok",
					text: "Check the test expectation.",
				},
				{
					name: "other",
					provider: "antigravity",
					model: "gemini-4-carbon-high",
					status: "unavailable",
					text: "Not signed in",
				},
			],
		};
	};
	const cards = [
		{ issue: 2, approval },
		{ issue: 3, approval },
	];
	try {
		const run = () =>
			externalReview(
				dir,
				topic,
				cards,
				"diagnosis",
				{ revision: "abcd" },
				new AbortController().signal,
				async () => "RETRY",
				broker,
				async (_, issue) => {
					seen.push(issue);
				},
			);
		const first = await run();
		assert.equal((await run()).inputDigest, first.inputDigest);
		assert.equal(calls, 1);
		assert.deepEqual(seen, [2, 3, 2, 3]);
		assert.match(adviserNotes(first), /Check the test/);
		assert.doesNotMatch(adviserNotes(first), /Not signed in/);
		for (const card of cards) {
			const record = JSON.parse(
				await readFile(
					join(
						dir,
						"assignments",
						String(card.issue),
						"consultations",
						"diagnosis.json",
					),
					"utf8",
				),
			);
			assert.equal(record.inputDigest, first.inputDigest);
			assert.equal(record.advice[1].status, "unavailable");
			assert.equal(record.advice[1].model, "gemini-4-carbon-high");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("retry only the failed independent adviser and retain both original and subsequent evidence", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jam-consult-retry-"));
	const requests: (string[] | undefined)[] = [];
	const provider = (name: string, status: "ok" | "error") => ({
		name,
		provider: name,
		status,
		text: status === "ok" ? "advice" : "timeout",
	});
	try {
		const broker: typeof exchange = async (_dir, req) => {
			requests.push(req.only);
			return {
				sha: "",
				advice: req.only
					? [provider("b", "ok")]
					: [provider("a", "ok"), provider("b", "error")],
			};
		};
		const run = await externalReview(
			dir,
			topic,
			[{ issue: 2, approval }],
			"architecture",
			{ draft: "ready" },
			new AbortController().signal,
			async () => "RETRY",
			broker,
			async () => {},
		);
		assert.deepEqual(requests, [undefined, ["b"]]);
		assert.deepEqual(
			run.advice.map((a) => a.status),
			["ok", "ok"],
		);
		const saved = JSON.parse(
			await readFile(
				join(dir, "consultations", run.inputDigest + ".json"),
				"utf8",
			),
		);
		assert.equal(saved.attempts[0][1].status, "error");
		assert.equal(saved.attempts[1][0].status, "ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("the owner sees the live request and can wait without starting another consultation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jam-consult-active-"));
	const seen: string[] = [];
	let calls = 0;
	try {
		const broker: typeof exchange = async (_dir, req, _signal, slow) => {
			calls++;
			assert.equal(req.only, undefined);
			const now = new Date().toISOString();
			await slow?.({
				phase: "architecture",
				updatedAt: now,
				providers: [
					{
						name: "active",
						provider: "codex",
						status: "running",
						startedAt: now,
						updatedAt: now,
					},
				],
			});
			return {
				sha: "",
				advice: [
					{ name: "active", provider: "codex", status: "ok", text: "Complete" },
				],
			};
		};
		const result = await externalReview(
			dir,
			topic,
			[{ issue: 2, approval }],
			"architecture",
			{ draft: "approved" },
			new AbortController().signal,
			async (input) => {
				seen.push(input.kind);
				return "WAIT The original review is still running.";
			},
			broker,
			async () => {},
		);
		assert.equal(calls, 1);
		assert.deepEqual(seen, ["in_flight"]);
		assert.equal(result.advice[0]?.status, "ok");
		const persisted = JSON.parse(
			await readFile(
				join(dir, "consultations", result.inputDigest + ".in_flight.json"),
				"utf8",
			),
		);
		assert.equal(persisted.decision, "WAIT");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("a saved escalation distinguishes first failure from an exhausted retry across recovery", async () => {
	for (const retry of [false, true]) {
		const dir = await mkdtemp(join(tmpdir(), "jam-escalation-"));
		const kinds: string[] = [];
		let calls = 0;
		const broker: typeof exchange = async () => {
			calls++;
			return {
				sha: "",
				advice: [
					{
						name: "Carbon",
						provider: "antigravity",
						status: "error",
						text: "Provider failed",
					},
				],
			};
		};
		try {
			const run = () =>
				externalReview(
					dir,
					topic,
					[{ issue: 2, approval }],
					"implementation",
					{ revision: "test" },
					new AbortController().signal,
					async (input) => {
						kinds.push(input.kind);
						return retry && input.kind === "confirmed_failure"
							? "RETRY"
							: "ESCALATE";
					},
					broker,
				);
			const reason = retry
				? /after the selective retry/
				: /after the initial call/;
			await assert.rejects(run(), reason);
			await assert.rejects(run(), reason);
			assert.equal(calls, retry ? 2 : 1);
			assert.deepEqual(
				kinds,
				retry
					? ["confirmed_failure", "retry_exhausted"]
					: ["confirmed_failure"],
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});
