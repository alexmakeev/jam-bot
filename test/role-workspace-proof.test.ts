import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleStage } from "../src/role-harness.js";
import { checkpointRole } from "../src/role-checkpoint.js";
import { RoleStageFailure } from "../src/role-failure.js";
import { fingerprint } from "../src/work-progress.js";
import { atomicJson } from "../src/storage.js";
import { bindWorkspace } from "../src/workspace-binding.js";
import { nativeWorkspaceEvidence } from "../src/native-teammate.js";

test("mandatory review evidence requires matching tool results from the exact native member", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-review-catalogue-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const config = join(state, "config"),
		cwd = join(state, "leo"),
		session = "b6812a26-cdcd-4e70-b98f-9252e31879ea";
	const name = "consultant-34-b6812a",
		handle = "native-reviewer",
		agentType = "jam-consultant-workspace-v1";
	const prefix = join(
			config,
			"projects",
			cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
			session,
		),
		member = join(prefix, "subagents", "agent-" + handle);
	const report = join(
		state,
		"assignments",
		"34",
		"workspace-access",
		"consultant-" + session,
	);
	const identity = { revision: "a".repeat(40), specifications: "b".repeat(64) },
		binding = { session, member: name, challenge: session };
	const pin = await bindWorkspace(
		report + ".manifest.json",
		{
			version: 1,
			identity,
			roots: { repository: state, specifications: state },
		},
		binding,
		report + ".jsonl",
	);
	await atomicJson(join(state, "native-dispatches", session + ".json"), {
		version: 2,
		session,
		name,
		agentType,
		challenge: session,
		workspacePin: pin,
	});
	await atomicJson(member + ".meta.json", {
		name,
		teamName: "session-b6812a26",
		taskKind: "in_process_teammate",
		customAgentType: agentType,
		spawnedAgentType: agentType,
	});
	const lead = [
		{
			sessionId: session,
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Agent",
						id: "spawn",
						input: { name, subagent_type: agentType, prompt: session },
					},
				],
			},
		},
		{
			sessionId: session,
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "spawn",
						content: "agent_id: " + handle,
					},
				],
			},
		},
	];
	await writeFile(
		prefix + ".jsonl",
		lead.map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
	const files = [
		["repository", "src/sum.ts"],
		["specifications", "index.json"],
	];
	await writeFile(
		report + ".jsonl",
		[
			{
				operation: "tools-list",
				tools: ["workspace_list", "workspace_read", "workspace_search"],
			},
			...files.map(([root, path]) => ({
				operation: "read",
				root,
				path,
				bytes: 20,
			})),
		]
			.map((event) => JSON.stringify({ identity, binding, ...event }))
			.join("\n") + "\n",
	);
	const row = (type: string, content: unknown) =>
		JSON.stringify({
			type,
			sessionId: session,
			cwd,
			agentId: handle,
			message: { content },
		});
	const save = (operations: string[]) =>
		writeFile(member + ".jsonl", operations.join("\n") + "\n");
	const evidence = () =>
		nativeWorkspaceEvidence(
			state,
			34,
			"consultant",
			identity.revision,
			{ config, cwd, session, name, agentType, challenge: session },
			handle,
		);
	await save([
		row("assistant", [{ type: "tool_use", name: "SendMessage", id: "mail" }]),
	]);
	assert.deepEqual(await evidence(), {
		advertised: true,
		memberCalls: 0,
		sourceRead: false,
		specificationIndexRead: false,
	});
	const calls = files.map(([root, path], i) => ({
		type: "tool_use",
		name: "mcp__jam_workspace__workspace_read",
		id: "read-" + i,
		input: { root, path },
	}));
	const responses = (specifications: string) =>
		files.map(([, path], i) => ({
			type: "tool_result",
			tool_use_id: "read-" + i,
			content: [
				{
					text: JSON.stringify({
						path,
						bytes: 20,
						identity: i === 0 ? identity : { ...identity, specifications },
					}),
				},
			],
		}));
	await save([row("assistant", calls), row("user", responses("c".repeat(64)))]);
	assert.deepEqual(await evidence(), {
		advertised: true,
		memberCalls: 2,
		sourceRead: true,
		specificationIndexRead: false,
	});
	await save([
		row("assistant", calls),
		row("user", responses(identity.specifications)),
	]);
	assert.deepEqual(await evidence(), {
		advertised: true,
		memberCalls: 2,
		sourceRead: true,
		specificationIndexRead: true,
	});
});

test("a routine workspace role can recover an authenticated receipt without source reads", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-role-inspection-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const job: RoleStage = {
		state,
		cwd: state,
		session: "lead",
		issue: 1,
		role: "architect",
		input: "inspect",
		workspaceManifest: join(state, "manifest.json"),
		signal: new AbortController().signal,
	};
	let executions = 0;
	const receipt = {
		developer: "native",
		nativeMember: "architect@team",
		backend: "in-process",
		team: "team",
		output: "A specification",
	};
	const run = async () => {
		executions++;
		throw Error("Native teammate receipt timed out");
	};
	const saved = await checkpointRole(
		job,
		"publish",
		run,
		async () => ({ receipt }),
		false,
	);
	const { dispatchIdentity, ...workProduct } = saved;
	assert.match(dispatchIdentity ?? "", /^architect-.*-received$/);
	assert.deepEqual(workProduct, receipt);
	assert.equal(executions, 1);
	assert.deepEqual(
		await checkpointRole(job, "publish", run, async () => ({ receipt }), false),
		saved,
	);
	assert.equal(executions, 1);
});

test("workspace recovery recognizes isolated and original native receipts without dispatch", async (t) => {
	const { observe } = await import("../src/review-supervisor.js");
	const config = await mkdtemp(join(tmpdir(), "jam-role-capabilities-"));
	t.after(() => rm(config, { recursive: true, force: true }));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = config;
	t.after(() => {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	});
	const session = "00000000-0000-4000-8000-000000000001",
		challenge = "10000000-0000-4000-8000-000000000001" as const;
	const cwd = join(config, "work"),
		name = "architect-1-" + challenge.slice(0, 6),
		output = challenge + "\nOriginal work product";
	const fixture = async (runtime: string, types: string[]) => {
		await rm(join(config, "projects"), { recursive: true, force: true });
		await rm(join(config, "teams"), { recursive: true, force: true });
		const team = "session-" + runtime.slice(0, 8),
			prefix = join(
				config,
				"projects",
				cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
				runtime,
			);
		await mkdir(join(config, "teams", team), { recursive: true });
		await mkdir(join(prefix, "subagents"), { recursive: true });
		await writeFile(
			join(config, "teams", team, "config.json"),
			JSON.stringify({
				leadSessionId: runtime,
				members: [
					{ name, agentId: name + "@" + team, cwd, backendType: "in-process" },
				],
			}),
		);
		await writeFile(
			join(prefix, "subagents", "agent-handle.jsonl"),
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							name: "SendMessage",
							input: { to: "main", message: output },
						},
					],
				},
			}) + "\n",
		);
		const rows = [
			{
				type: "assistant",
				sessionId: runtime,
				message: {
					content: types.flatMap((subagent_type, i) => [
						{
							type: "tool_use",
							id: "call-" + i,
							name: "Agent",
							input: { name, subagent_type, prompt: challenge },
						},
						{
							type: "tool_result",
							tool_use_id: "call-" + i,
							content: "agent_id: handle",
						},
					]),
				},
			},
			{
				type: "user",
				sessionId: runtime,
				message: {
					content:
						'Another Claude session sent a message:\n<agent-message from="' +
						name +
						'">\n' +
						output +
						"\n</agent-message>",
				},
			},
		];
		await writeFile(
			prefix + ".jsonl",
			rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
		);
		return prefix;
	};
	const job: RoleStage = {
		state: config,
		cwd,
		session,
		issue: 1,
		role: "architect",
		input: "inspect",
		workspaceManifest: join(config, "manifest.json"),
		signal: new AbortController().signal,
	};
	const attempt = { challenge, startedAt: Date.now() - 1000 };
	for (const [runtime, type] of [
		[challenge, "jam-architect-workspace-v1"],
		[session, "jam-architect-workspace-v1"],
		[session, "jam-architect"],
	]) {
		await fixture(runtime!, [type!]);
		assert.equal(
			(await observe(job, attempt)).receipt?.output,
			"Original work product",
		);
	}
	await fixture(session, ["jam-architect-workspace-v1", "jam-architect"]);
	await assert.rejects(observe(job, attempt), /Ambiguous original role/);
	const prefix = await fixture(challenge, ["jam-architect-workspace-v1"]);
	await writeFile(
		prefix + ".jsonl",
		JSON.stringify({
			type: "assistant",
			sessionId: challenge,
			isApiErrorMessage: true,
			timestamp: new Date().toISOString(),
			message: { stop_reason: "refusal" },
		}) + "\n",
	);
	assert.deepEqual(await observe(job, attempt), { refused: true });
});

test("a recovered runtime blocker cannot become an architecture handoff or trigger a retry", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-role-blocker-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const job: RoleStage = {
		state,
		cwd: state,
		session: "lead",
		issue: 1,
		role: "architect",
		input: "plan",
		workspaceManifest: join(state, "manifest.json"),
		signal: new AbortController().signal,
	};
	const receipt = {
		developer: "native",
		nativeMember: "architect@team",
		backend: "in-process",
		team: "team",
		output: "Blocked: workspace tools unavailable",
	};
	let executions = 0;
	const run = async () => {
		executions++;
		throw Error("Native teammate receipt timed out");
	};
	const rejects = () =>
		assert.rejects(
			checkpointRole(job, "publish", run, async () => ({ receipt }), false),
			(error: unknown) =>
				error instanceof RoleStageFailure &&
				error.category === "runtime_failure" &&
				error.localDetail === receipt.output,
		);
	await rejects();
	await rejects();
	assert.equal(executions, 1);
});

test("a historical blocker stored as a receipt is reclassified before dispatching changed role input", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-role-legacy-blocker-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const job: RoleStage = {
		state,
		cwd: state,
		session: "lead",
		issue: 1,
		role: "architect",
		input: "original plan",
		signal: new AbortController().signal,
	};
	const receipt = {
		developer: "native",
		nativeMember: "architect@team",
		backend: "in-process",
		team: "team",
		output: "Blocked: workspace refused access",
	};
	const path = join(
		state,
		"assignments",
		"1",
		"roles",
		"architect-" + fingerprint(job.input) + ".json",
	);
	await atomicJson(path, {
		session: job.session,
		input: job.input,
		challenge: "original",
		startedAt: Date.now(),
		attempt: 1,
		receipt,
	});
	const noDispatch = async () =>
		assert.fail("A blocked result must not dispatch a replacement");
	const isBlocker = (error: unknown) =>
		error instanceof RoleStageFailure &&
		error.category === "runtime_failure" &&
		error.localDetail === receipt.output;
	await assert.rejects(
		checkpointRole(
			{ ...job, input: "changed plan" },
			"publish",
			noDispatch,
			noDispatch,
			false,
		),
		isBlocker,
	);
	await assert.rejects(
		checkpointRole(job, "publish", noDispatch, noDispatch, false),
		isBlocker,
	);
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.equal(saved.failureCategory, "runtime_failure");
	assert.deepEqual(saved.receipt, receipt);
});
