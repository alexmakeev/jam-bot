import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	diagnosticOperations,
	diagnosticText,
} from "../src/management-diagnostics.js";
import { Journal } from "../src/intake-journal.js";
import { recordProgress, fingerprint } from "../src/work-progress.js";
import { atomicJson } from "../src/storage.js";

test("diagnostics drill down without exposing role inputs, raw logs or credential files", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-diagnostics-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const journal = new Journal(join(state, "intake.sqlite"));
	t.after(() => journal.db.close());
	journal.db
		.prepare(
			"INSERT INTO intake(delivery,issue,action,title,body,state,workerState) VALUES(?,?,?,?,?,?,?)",
		)
		.run(
			"fixture",
			1,
			"task",
			"Example",
			"private source prompt",
			"acked",
			"review",
		);
	const topic = {
		repository: "fixture/project",
		repoId: 1,
		installation: 2,
		cwd: join(state, "leo"),
	};
	journal.start(topic);
	const operation = diagnosticOperations(
		new Map([["fixture", { state, topic, journal }]]),
	)[0]!;
	const call = (raw: Record<string, unknown>) =>
		operation.run(
			operation.input.parse({
				serverId: "00000000-0000-4000-8000-000000000001",
				repoId: 1,
				...raw,
			}),
		);
	await mkdir(join(state, ".creds"));
	await writeFile(join(state, ".creds", "token"), "CREDENTIAL-CANARY");
	await atomicJson(
		join(
			state,
			"assignments",
			"1",
			"roles",
			"architect-" + "a".repeat(64) + ".json",
		),
		{
			input: "PROMPT-CANARY",
			failureDetail: "PRIVATE-DIAGNOSTIC",
			failure: "refused",
			failureCategory: "refusal",
			startedAt: Date.now(),
			attempt: 1,
		},
	);
	await atomicJson(
		join(
			state,
			"mandatory-reviews",
			"integrator-1-" + "b".repeat(40) + ".json",
		),
		{
			input: "REVIEW-PROMPT-CANARY",
			attempts: [{ startedAt: Date.now() }],
			receipt: { output: "PRIVATE-OUTPUT" },
		},
	);
	recordProgress(state, 1, "first", "First milestone", {
		purpose: "tests",
		markdown: "# Tests\n\nAuthorization: Bearer abcdefghijklmnopqrstuv",
	});
	recordProgress(state, 1, "second", "Second milestone");
	journal.db
		.prepare(
			"INSERT INTO intake(delivery,issue,action,title,body,state) VALUES(?,?,?,?,?,?)",
		)
		.run(
			"queued",
			2,
			"task",
			"Queued independent work",
			"OTHER-PRIVATE-SOURCE",
			"queued",
		);
	const summary = await call({});
	assert.equal(summary.view, "summary");
	assert.ok((summary.data as { disk: unknown }).disk);
	assert.deepEqual((summary.data as { coordination: unknown }).coordination, {
		reviewBarrier: true,
		blockingIssueCount: 1,
		blockingIssues: [{ issue: 1, phase: "worker" }],
	});
	assert.ok(!JSON.stringify(summary).includes("OTHER-PRIVATE-SOURCE"));
	const agents = await call({ view: "agents", issue: 1 });
	const serialized = JSON.stringify(agents);
	assert.match(serialized, /integrator/);
	assert.match(serialized, /refusal/);
	for (const marker of [
		"PROMPT-CANARY",
		"PRIVATE-DIAGNOSTIC",
		"PRIVATE-OUTPUT",
		"CREDENTIAL-CANARY",
	])
		assert.ok(!serialized.includes(marker));
	const events = await call({ view: "events", issue: 1, limit: 1 });
	assert.equal(events.next, 1);
	assert.match(JSON.stringify(events), /Second milestone/);
	assert.deepEqual((await call({ view: "artifacts", issue: 1 })).data, []);
	const db = new DatabaseSync(join(state, "work-progress.sqlite"));
	db.prepare(
		"UPDATE events SET status='sent',receipt=123 WHERE issue=1 AND key=?",
	).run(fingerprint("first"));
	db.close();
	const artifacts = await call({ view: "artifacts", issue: 1 });
	const id = (artifacts.data as { id: string }[])[0]!.id;
	const report = await call({ view: "artifact", issue: 1, artifactId: id });
	assert.ok(!JSON.stringify(report).includes("abcdefghijklmnopqrstuv"));
	const pendingId = id.split(":")[1];
	await assert.rejects(
		call({ view: "artifact", issue: 999, artifactId: "tests:" + pendingId }),
	);
	const bounded = await call({ view: "agents", issue: 1, maxBytes: 512 });
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 512);
	await assert.rejects(call({ view: "agents", issue: 999 }));
	assert.throws(() =>
		operation.input.parse({
			serverId: "00000000-0000-4000-8000-000000000001",
			repoId: 1,
			path: "/etc/passwd",
		}),
	);
	assert.ok(!diagnosticText("password=secret-value").includes("secret-value"));
});

test("diagnostics paginate all consultant records, cap serialized bytes and project inspection fields", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-diagnostics-budget-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const journal = new Journal(join(state, "intake.sqlite"));
	t.after(() => journal.db.close());
	journal.db
		.prepare(
			"INSERT INTO intake(delivery,issue,action,title,body,state) VALUES(?,?,?,?,?,?)",
		)
		.run("fixture", 1, "task", "Example", "", "acked");
	const topic = {
		repository: "fixture/project",
		repoId: 1,
		installation: 2,
		cwd: join(state, "leo"),
	};
	journal.start(topic);
	const operation = diagnosticOperations(
		new Map([["fixture", { state, topic, journal }]]),
	)[0]!;
	const call = (raw: Record<string, unknown>) =>
		operation.run(
			operation.input.parse({
				serverId: "00000000-0000-4000-8000-000000000001",
				repoId: 1,
				issue: 1,
				...raw,
			}),
		);
	await atomicJson(
		join(state, "assignments", "1", "consultations", "architecture.json"),
		{
			advice: Array.from({ length: 12 }, (_, i) => ({
				provider: "codex",
				model: "model-" + i,
				status: "ok",
			})),
			inspection: [
				{
					revision: "a".repeat(40),
					readers: [
						{
							reader: "codex-1",
							events: [
								{
									operation: "read",
									root: "repository",
									path: "src/a.ts",
									bytes: 100,
									content: "PRIVATE-CANARY",
								},
							],
						},
					],
				},
			],
		},
	);
	let offset = 0,
		total = 0;
	for (let page = 0; page < 20; page++) {
		const result = await call({
			view: "agents",
			offset,
			limit: 10,
			maxBytes: 512,
		});
		assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512);
		total += (result.data as unknown[]).length;
		if (result.next === null) break;
		assert.ok(Number(result.next) > offset);
		offset = Number(result.next);
	}
	assert.equal(total, 12);
	assert.ok(
		!JSON.stringify(await call({ view: "inspection" })).includes(
			"PRIVATE-CANARY",
		),
	);
	recordProgress(state, 1, "pending", "Pending", {
		purpose: "tests",
		markdown: "UNPUBLISHED-CANARY",
	});
	const db = new DatabaseSync(join(state, "work-progress.sqlite"));
	const digest = db
		.prepare("SELECT digest FROM event_reports LIMIT 1")
		.get()!.digest;
	db.close();
	await assert.rejects(
		call({ view: "artifact", artifactId: "tests:" + digest }),
	);
});

type ArtifactPage = {
	view: string;
	data: { artifactId: string; text: string; totalBytes: number };
	next: number | null;
	limitations: string[];
};

async function publishedReport(
	t: { after(fn: () => unknown): void },
	markdown: string,
) {
	const state = await mkdtemp(join(tmpdir(), "jam-diagnostics-unicode-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const journal = new Journal(join(state, "intake.sqlite"));
	t.after(() => journal.db.close());
	journal.db
		.prepare(
			"INSERT INTO intake(delivery,issue,action,title,body,state) VALUES(?,?,?,?,?,?)",
		)
		.run("fixture", 1, "task", "Example", "", "acked");
	const topic = {
		repository: "fixture/project",
		repoId: 1,
		installation: 2,
		cwd: join(state, "leo"),
	};
	journal.start(topic);
	const operation = diagnosticOperations(
		new Map([["fixture", { state, topic, journal }]]),
	)[0]!;
	recordProgress(state, 1, "report", "Report milestone", {
		purpose: "tests",
		markdown,
	});
	const db = new DatabaseSync(join(state, "work-progress.sqlite"));
	db.prepare(
		"UPDATE events SET status='sent',receipt=123 WHERE issue=1 AND key=?",
	).run(fingerprint("report"));
	db.close();
	const artifactId = "tests:" + fingerprint(markdown);
	return async (offset: number, maxBytes: number) => {
		const result: unknown = await operation
			.run(
				operation.input.parse({
					serverId: "00000000-0000-4000-8000-000000000001",
					repoId: 1,
					issue: 1,
					view: "artifact",
					artifactId,
					offset,
					maxBytes,
				}),
			)
			.then(
				(value) => value,
				(error: unknown) => error,
			);
		assert.ok(
			!(result instanceof Error),
			`offset ${offset}, maxBytes ${maxBytes}: artifact page failed: ${String(result)}`,
		);
		return result as ArtifactPage;
	};
}

test("artifact pages end before a Unicode character split by the response budget", async (t) => {
	const markdown = "\u20ac\u{1f600}".repeat(200);
	const redacted = Buffer.from(diagnosticText(markdown));
	const page = await publishedReport(t, markdown);
	for (const offset of [0, 3]) {
		const remaining = Array.from(redacted.subarray(offset).toString("utf8"));
		for (let maxBytes = 480; maxBytes <= 560; maxBytes++) {
			const label = `offset ${offset}, maxBytes ${maxBytes}`;
			const result = await page(offset, maxBytes);
			const text = result.data.text;
			const characters = Array.from(text).length;
			assert.ok(!text.includes("\ufffd"), `${label}: page contains U+FFFD`);
			assert.ok(characters > 0, `${label}: empty page`);
			assert.equal(
				text,
				remaining.slice(0, characters).join(""),
				`${label}: page is not the report prefix`,
			);
			assert.equal(
				result.next,
				offset + Buffer.byteLength(text),
				`${label}: next cursor`,
			);
			assert.equal(
				result.data.totalBytes,
				redacted.length,
				`${label}: totalBytes`,
			);
			assert.ok(
				Buffer.byteLength(JSON.stringify(result)) <= maxBytes,
				`${label}: response exceeds maxBytes`,
			);
			const following = remaining[characters];
			assert.ok(following !== undefined, `${label}: fixture too short`);
			const extended = text + following;
			const end = offset + Buffer.byteLength(extended);
			const grown = {
				...result,
				data: { ...result.data, text: extended },
				next: end < redacted.length ? end : null,
			};
			assert.ok(
				Buffer.byteLength(JSON.stringify(grown)) > maxBytes,
				`${label}: page stops before a complete character that fits`,
			);
		}
	}
});

test("following artifact cursors rebuilds the complete redacted report", async (t) => {
	const markdown = Array.from(
		{ length: 12 },
		(_, i) =>
			`## Section ${i} "quoted" C:\\temp\tcell\u0001 cafe\u0301 caf\u00e9 \u20ac \u{1f600} \u{1d11e} \ufffd ghp_${"A".repeat(20)} password=hunter2-${i}\n`,
	).join("");
	const expected = diagnosticText(markdown);
	assert.ok(!expected.includes("hunter2") && !expected.includes("ghp_"));
	const total = Buffer.byteLength(expected);
	const page = await publishedReport(t, markdown);
	for (let maxBytes = 480; maxBytes <= 544; maxBytes++) {
		const pieces: string[] = [];
		let offset = 0;
		for (;;) {
			const label = `offset ${offset}, maxBytes ${maxBytes}`;
			assert.ok(pieces.length < 200, `${label}: too many pages`);
			const result = await page(offset, maxBytes);
			const text = result.data.text;
			assert.ok(
				Buffer.byteLength(JSON.stringify(result)) <= maxBytes,
				`${label}: response exceeds maxBytes`,
			);
			assert.equal(result.data.totalBytes, total, `${label}: totalBytes`);
			assert.ok(text.length > 0, `${label}: empty page`);
			assert.ok(
				!text.includes("hunter2") && !text.includes("ghp_"),
				`${label}: credential exposed`,
			);
			pieces.push(text);
			const end = offset + Buffer.byteLength(text);
			if (result.next === null) {
				assert.equal(end, total, `${label}: report ended early`);
				break;
			}
			assert.equal(result.next, end, `${label}: next cursor`);
			assert.ok(result.next > offset, `${label}: cursor did not advance`);
			offset = result.next;
		}
		assert.ok(
			pieces.length > 1,
			`maxBytes ${maxBytes}: expected several pages`,
		);
		assert.equal(
			pieces.join(""),
			expected,
			`maxBytes ${maxBytes}: joined pages differ from the redacted report`,
		);
	}
});
