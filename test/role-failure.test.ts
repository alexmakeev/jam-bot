import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRoleFailure, RoleStageFailure } from "../src/role-failure.js";
import { checkpointRole } from "../src/role-checkpoint.js";
import { stageRefused } from "../src/native-teammate.js";

const topic = {
	repository: "owner/repo",
	repoId: 10,
	installation: 11,
	cwd: "/unused",
};

test("refusal detection accepts a complete final row without newline and ignores an in-flight final row", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "refusal-final-row-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl"),
		at = Date.now();
	const row = JSON.stringify({
		type: "assistant",
		sessionId: "lead",
		isApiErrorMessage: true,
		message: { stop_reason: "refusal" },
		timestamp: new Date(at).toISOString(),
	});
	await writeFile(path, row);
	assert.equal(await stageRefused(path, "lead", at), true);
	assert.equal(await stageRefused(path, "another", at), false);
	await writeFile(path, row.slice(0, -5));
	assert.equal(await stageRefused(path, "lead", at), false);
	await writeFile(path, row + "\n" + row.slice(0, -5));
	assert.equal(await stageRefused(path, "lead", at), true);
});

test("a refused role persists its safe category and original local diagnostic and is never resubmitted", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "role-refusal-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const job = {
		state,
		cwd: state,
		session: "lead",
		issue: 35,
		role: "architect" as const,
		input: "original task",
		signal: new AbortController().signal,
	};
	let calls = 0;
	const detail =
		"Native teammate spawn was declined by the harness; private diagnostic token=sample-secret";
	const run = async () => {
		calls++;
		throw Error(detail);
	};
	for (let i = 0; i < 2; i++)
		await assert.rejects(
			checkpointRole(job, "publish specification", run),
			(error) => {
				assert.ok(error instanceof RoleStageFailure);
				assert.equal(error.category, "harness_refusal");
				assert.equal(error.localDetail, detail);
				assert.doesNotMatch(error.message, /sample-secret/);
				assert.doesNotMatch(JSON.stringify(error), /sample-secret/);
				return true;
			},
		);
	assert.equal(calls, 1);
	await assert.rejects(
		checkpointRole(
			{
				...job,
				input: "Same task with new workspace metadata",
				workspaceManifest: join(state, "new-manifest.json"),
			},
			"publish specification",
			run,
		),
		RoleStageFailure,
	);
	assert.equal(calls, 1);
	const directory = join(state, "assignments", "35", "roles");
	const files = await readdir(directory);
	const saved = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
	assert.equal(saved.failureCategory, "harness_refusal");
	assert.equal(saved.failureDetail, detail);
});

test("changed role inputs reconcile a harness-only refusal before dispatching a replacement", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "role-refusal-window-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const directory = join(state, "assignments", "1", "roles");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "architect-" + "a".repeat(64) + ".json"),
		JSON.stringify({
			session: "lead",
			input: "Original input",
			challenge: "original",
			startedAt: Date.now(),
			attempt: 1,
		}),
	);
	const job = {
		state,
		cwd: state,
		session: "lead",
		issue: 1,
		role: "architect" as const,
		input: "Changed excerpts",
		signal: new AbortController().signal,
	};
	await assert.rejects(
		checkpointRole(
			job,
			"publish",
			async () => {
				assert.fail("A refused stage must not be dispatched again");
			},
			async (original) => {
				assert.equal(original.input, "Original input");
				return { refused: true };
			},
		),
		(error) =>
			error instanceof RoleStageFailure && error.category === "harness_refusal",
	);
});

test("a historical role incident publishes one sanitized role report with responsible mention and survives ambiguous publication", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "role-incident-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const records: { identity: string; summary: string; report: unknown }[] = [];
	let confirms = 0;
	const deps = {
		profile: async () => ({
			markdown: "",
			owner: "owner",
			revision: "a".repeat(40),
			responsibilities: [
				{ area: "architecture", role: "Architect", login: "architect-owner" },
			],
		}),
		record: (
			_state: string,
			_issue: number,
			identity: string,
			summary: string,
			report: unknown,
		) => {
			records.push({ identity, summary, report });
		},
		confirm: async () => {
			if (++confirms === 1) throw Error("lost response");
			return 77;
		},
	};
	const request = {
		state,
		topic,
		issue: 35,
		error: Error(
			"Native architect refused or declined architect-35-abcd. token=sample-secret",
		),
	};
	await assert.rejects(publishRoleFailure(request, deps), /lost response/);
	const result = await publishRoleFailure(request, deps);
	const replay = await publishRoleFailure(request, deps);
	assert.equal(result.commentId, 77);
	assert.deepEqual(replay, result);
	assert.equal(confirms, 2);
	assert.equal(records[0]!.identity, records[1]!.identity);
	assert.match(records[0]!.summary, /❓ @architect-owner/);
	assert.doesNotMatch(
		JSON.stringify(records),
		/sample-secret|architect-35-abcd|token=/,
	);
	const markdown = (records[0]!.report as { markdown: string }).markdown;
	assert.match(markdown, /Role: Architect/);
	assert.match(markdown, /harness_refusal/);
	const directory = join(state, "role-incidents", "35");
	const files = await readdir(directory);
	assert.equal(files.length, 1);
	const saved = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
	assert.match(saved.detail, /sample-secret/);
	assert.equal(saved.commentId, 77);
});

test("a generic historical stop resolves its producing role from the saved failed checkpoint without dispatch", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "historical-role-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const { mkdir } = await import("node:fs/promises");
	const directory = join(state, "assignments", "35", "roles");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "architect-previous.json"),
		JSON.stringify({
			startedAt: 1,
			failure: "Native architect refused or declined a saved invocation",
		}),
	);
	let summary = "";
	let report = "";
	const result = await publishRoleFailure(
		{
			state,
			topic,
			issue: 35,
			error: Error("An incomplete stage was retained for diagnosis"),
		},
		{
			profile: async () => ({
				markdown: "",
				owner: "owner",
				revision: "a".repeat(40),
				responsibilities: [],
			}),
			record: (_state, _issue, _identity, value, artifact) => {
				summary = value;
				report = (artifact as { markdown: string }).markdown;
			},
			confirm: async () => 91,
		},
	);
	assert.equal(result.role, "architect");
	assert.equal(result.category, "harness_refusal");
	assert.match(summary, /❓ @owner/);
	assert.match(report, /Role: Architect/);
});

test("normal refusal and automatic fallback metadata block acceptance even beyond a large transcript tail", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "refusal-metadata-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl"),
		at = Date.now();
	const refusal = {
		type: "assistant",
		sessionId: "lead",
		message: { stop_reason: "refusal" },
		timestamp: new Date(at).toISOString(),
	};
	const padding =
		JSON.stringify({
			type: "user",
			sessionId: "lead",
			message: { content: "x".repeat(262144) },
		}) + "\n";
	await writeFile(path, JSON.stringify(refusal) + "\n" + padding);
	assert.equal(await stageRefused(path, "lead", at), true);
	assert.equal(await stageRefused(path, "lead", at + 1), false);
	assert.equal(
		await stageRefused(path, "lead", at - 10, undefined, at - 1),
		false,
	);
	await writeFile(
		path,
		JSON.stringify({ ...refusal, agentId: "native-a", cwd: dir }) + "\n",
	);
	assert.equal(
		await stageRefused(path, "lead", at, { handle: "native-a", cwd: dir }),
		true,
	);
	assert.equal(
		await stageRefused(path, "lead", at, { handle: "native-b", cwd: dir }),
		false,
	);
	const fallback = {
		type: "system",
		subtype: "model_refusal_fallback",
		sessionId: "lead",
		timestamp: new Date(at).toISOString(),
	};
	await writeFile(path, JSON.stringify(fallback) + "\n" + padding);
	assert.equal(await stageRefused(path, "lead", at), true);
	await writeFile(
		path,
		JSON.stringify({
			type: "user",
			sessionId: "lead",
			timestamp: new Date(at).toISOString(),
			message: { content: JSON.stringify(refusal) },
		}) + "\n",
	);
	assert.equal(await stageRefused(path, "lead", at), false);
});

test("a fallback work product cannot hide a refusal or dispatch a replacement role", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "role-fallback-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = join(state, "config");
	t.after(() => {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	});
	const job = {
		state,
		cwd: state,
		session: "lead",
		issue: 1,
		role: "architect" as const,
		input: "Authorized work",
		signal: new AbortController().signal,
	};
	const log = join(
		process.env.CLAUDE_CONFIG_DIR,
		"projects",
		state.replace(/[^a-zA-Z0-9-]/g, "-"),
		"lead.jsonl",
	);
	let runs = 0;
	const run = async () => {
		runs++;
		await mkdir(
			join(
				process.env.CLAUDE_CONFIG_DIR!,
				"projects",
				state.replace(/[^a-zA-Z0-9-]/g, "-"),
			),
			{ recursive: true },
		);
		await writeFile(
			log,
			JSON.stringify({
				type: "assistant",
				sessionId: "lead",
				timestamp: new Date().toISOString(),
				message: { stop_reason: "refusal" },
			}) + "\n",
		);
		return {
			developer: "native",
			nativeMember: "architect@team",
			backend: "in-process",
			team: "team",
			output: "Unapproved fallback work product",
		};
	};
	for (let i = 0; i < 2; i++)
		await assert.rejects(
			checkpointRole(job, "publish", run, async () => ({}), false),
			(error) =>
				error instanceof RoleStageFailure &&
				error.category === "harness_refusal",
		);
	assert.equal(runs, 1);
});
