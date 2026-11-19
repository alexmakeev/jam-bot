import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SharedWorkspace } from "../src/shared-workspace.js";
import { bindWorkspace, workspaceDigest } from "../src/workspace-binding.js";

test("shared MCP grants a one-use read only to the authenticated member and current revision", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jam-shared-admission-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "admission.sqlite");
	const workspace = new SharedWorkspace(path, true);
	t.after(() => workspace.close());
	const session = "topic-generation";
	const cwd = "/fixture/lead",
		agentType = "fixture-member";
	const native = join(root, "projects", "-fixture-lead", session);
	const transcript = native + ".jsonl";
	await mkdir(join(native, "subagents"), { recursive: true });
	const spawn = ["a", "b"].flatMap((name) => [
		{
			type: "assistant",
			sessionId: session,
			message: {
				content: [
					{
						type: "tool_use",
						name: "Agent",
						id: "spawn-" + name,
						input: { name, subagent_type: agentType, prompt: "boot-" + name },
					},
				],
			},
		},
		{
			type: "user",
			sessionId: session,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "spawn-" + name,
						content: "agent_id: native-" + name,
					},
				],
			},
		},
		{
			type: "user",
			sessionId: session,
			message: {
				content:
					'Another Claude session sent a message:\n<agent-message from="' +
					name +
					'">\nboot-' +
					name +
					"\n</agent-message>",
			},
		},
	]);
	await writeFile(
		transcript,
		spawn.map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
	for (const name of ["a", "b"]) {
		const file = join(native, "subagents", "agent-native-" + name);
		await writeFile(
			file + ".meta.json",
			JSON.stringify({
				name,
				teamName: "session-" + session.slice(0, 8),
				taskKind: "in_process_teammate",
				customAgentType: agentType,
				spawnedAgentType: agentType,
			}),
		);
		await writeFile(
			file + ".jsonl",
			JSON.stringify({
				type: "assistant",
				cwd,
				agentId: "native-" + name,
				sessionId: session,
				message: {
					content: [
						{
							type: "tool_use",
							id: "reply-" + name,
							name: "SendMessage",
							input: { to: "main", message: "boot-" + name },
						},
					],
				},
			}) + "\n",
		);
		assert.equal(
			await workspace.enroll({
				config: root,
				cwd,
				session,
				name,
				agentType,
				challenge: "boot-" + name,
				expected: "boot-" + name,
			}),
			"native-" + name,
		);
	}
	const client = new Client({ name: "native-protocol-fixture", version: "1" });
	t.after(() => client.close());
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [
				new URL("../src/workspace-mcp.js", import.meta.url).pathname,
				"--shared",
				path,
				session,
				join(root, "catalog.json"),
			],
			stderr: "ignore",
		}),
	);

	const a = await setup("a", "first", "a");
	const b = await setup("b", "second", "b");
	async function setup(member: string, id: string, revision: string) {
		const repository = join(root, id),
			specifications = join(repository, "specs");
		await mkdir(specifications, { recursive: true });
		await writeFile(join(repository, "value.txt"), "marker-" + revision);
		const manifest = join(root, id + ".json");
		const pin = await bindWorkspace(
			manifest,
			{
				version: 1,
				identity: {
					revision: revision.repeat(40),
					specifications: revision.repeat(64),
				},
				roots: { repository, specifications },
			},
			{ session, member, challenge: id },
			join(root, id + ".jsonl"),
		);
		const prompt = "submit " + id,
			request = "read " + id,
			turn = "prompt-" + id,
			handle = "native-" + member;
		assert.throws(
			() =>
				workspace.prepare({
					id,
					session,
					handle: "unverified",
					member,
					manifest,
					digest: pin,
					transcript,
					promptDigest: workspaceDigest(prompt),
					requestDigest: workspaceDigest(request),
				}),
			/no enrolled native member/,
		);
		workspace.prepare({
			id,
			session,
			handle,
			member,
			manifest,
			digest: pin,
			transcript,
			promptDigest: workspaceDigest(prompt),
			requestDigest: workspaceDigest(request),
		});
		return {
			id,
			handle,
			turn,
			rows: [
				{
					type: "user",
					sessionId: session,
					promptId: turn,
					message: {
						content:
							member === "b"
								? `<pasted_content id="abcd">\n${prompt}\n</pasted_content id="abcd">`
								: prompt,
					},
				},
				{
					type: "assistant",
					sessionId: session,
					message: {
						content: [
							{
								type: "tool_use",
								id: "send-" + id,
								name: "SendMessage",
								input: { to: member, message: request },
							},
						],
					},
				},
				{
					type: "user",
					sessionId: session,
					promptId: turn,
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "send-" + id,
								content: '{"success":true}',
							},
						],
					},
				},
			],
		};
	}
	await client.listTools();
	assert.deepEqual(
		JSON.parse(await readFile(join(root, "catalog.json"), "utf8")),
		{
			session,
			tools: ["workspace_list", "workspace_read", "workspace_search"],
		},
	);
	const arguments_ = { root: "repository", path: "value.txt" };
	const authorize = (
		scope: typeof a,
		id: string,
		actor = scope.handle,
		prompt = scope.turn,
	) =>
		workspace.admit({
			session_id: session,
			agent_id: actor,
			prompt_id: prompt,
			tool_use_id: "toolu_" + id,
			tool_name: "mcp__jam_workspace__workspace_read",
			tool_input: arguments_,
		});
	const read = (id: string, input = arguments_) =>
		client.callTool({
			name: "workspace_read",
			arguments: input,
			_meta: { "claudecode/toolUseId": "toolu_" + id },
		});
	await writeFile(
		transcript,
		[...a.rows, ...b.rows].map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
	assert.equal((await read("none")).isError, true);
	assert.equal(
		(
			await client.callTool({
				name: "workspace_read",
				arguments: { ...arguments_, "claudecode/toolUseId": "toolu_correct_a" },
			})
		).isError,
		true,
	);
	assert.equal(await authorize(a, "wrong_actor", b.handle), false);
	assert.equal(await authorize(a, "lead", ""), false);
	assert.equal(await authorize(a, "correct_a"), true);
	assert.equal(await authorize(b, "correct_b"), true);
	assert.equal(
		(await read("correct_a", { ...arguments_, path: "../second/value.txt" }))
			.isError,
		true,
	);
	assert.match(JSON.stringify(await read("correct_a")), /marker-a/);
	assert.match(JSON.stringify(await read("correct_b")), /marker-b/);
	assert.deepEqual(
		[...workspace.usedCalls(a.id, session, a.handle)],
		["toolu_correct_a"],
	);
	assert.deepEqual([...workspace.usedCalls(a.id, session, b.handle)], []);
	assert.equal((await read("correct_a")).isError, true);
	assert.equal(await authorize(a, "correct_a"), false);

	assert.equal(await authorize(a, "outstanding"), true);
	assert.equal(await authorize(a, "stale"), true);
	const claim = workspace.take(
		"toolu_outstanding",
		session,
		"workspace_read",
		arguments_,
	);
	assert.throws(() => workspace.retire(a.id), /have not drained/);
	assert.equal((await read("stale")).isError, true);
	assert.equal(await authorize(a, "new_call_during_retirement"), false);
	await assert.rejects(setup("a", "third", "c"), /readers have not drained/);
	claim.finish();
	const recovered = new SharedWorkspace(path);
	try {
		recovered.retire(a.id);
	} finally {
		recovered.close();
	}
	const next = await setup("a", "third", "c");
	await writeFile(
		transcript,
		[...a.rows, ...b.rows, ...next.rows]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);
	assert.equal(await authorize(next, "old_turn", next.handle, a.turn), false);
	assert.equal(await authorize(next, "new_turn"), true);
	assert.match(JSON.stringify(await read("new_turn")), /marker-c/);
});
