import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runRoleStage } from "../dist/src/role-harness.js";

const state = await mkdtemp(join(tmpdir(), "jam-native-delivery-"));
const cwd = join(state, "lead");
const repository = join(state, "repository");
const specifications = join(state, "specifications");
const protectedPath = ".creds/canary.txt";
await Promise.all([
	mkdir(cwd),
	mkdir(join(repository, ".creds"), { recursive: true }),
	mkdir(specifications),
]);

const source = randomUUID();
const index = randomUUID();
const protectedValue = randomUUID();
const challenge = randomUUID();
const identity = { revision: "a".repeat(40), specifications: "b".repeat(64) };
const workspaceManifest = join(state, "manifest.json");
await Promise.all([
	writeFile(
		join(repository, "probe.ts"),
		"export const marker = " + JSON.stringify(source),
	),
	writeFile(join(repository, protectedPath), protectedValue),
	writeFile(
		join(specifications, "index.json"),
		JSON.stringify({ index, entries: [] }),
	),
	writeFile(
		workspaceManifest,
		JSON.stringify({
			version: 1,
			identity,
			roots: { repository, specifications },
		}),
	),
]);

console.log(JSON.stringify({ state, challenge }));
const result = await runRoleStage(
	{
		role: "architect",
		state,
		cwd,
		session: randomUUID(),
		issue: 1,
		workspaceManifest,
		signal: AbortSignal.timeout(150000),
		effort: "medium",
		input:
			"Isolated tool delivery diagnostic. Read specifications/index.json and repository/probe.ts with workspace_read. Request repository path .creds/canary.txt with workspace_read to verify that this synthetic protected path is denied. Return JSON with the source marker as source, the index marker as index, and boolean denied for the protected read. If the tools are unavailable, report that blocker. No implementation.",
	},
	challenge,
);

assert.ok(
	!result.output.includes(protectedValue),
	"Protected content must not appear in the result",
);
const output = JSON.parse(result.output);
assert.equal(
	output.source === source && output.index === index && output.denied === true,
	true,
	"The receipt must prove both independent reads and protected-path rejection",
);

const audit = join(
	state,
	"assignments",
	"1",
	"workspace-access",
	"architect-" + challenge + ".jsonl",
);
const rows = (await readFile(audit, "utf8"))
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
for (const row of rows) assert.deepEqual(row.identity, identity);
for (const [root, path] of [
	["repository", "probe.ts"],
	["specifications", "index.json"],
]) {
	assert.ok(
		rows.some(
			(row) =>
				row.root === root &&
				row.path === path &&
				row.operation === "read" &&
				row.bytes > 0,
		),
	);
}
assert.ok(rows.some((row) => row.operation === "rejected-call"));
assert.ok(
	!rows.some((row) => row.operation === "read" && row.path === protectedPath),
);

const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const transcript = join(
	config,
	"projects",
	cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
	challenge,
	"subagents",
	"agent-" + result.developer + ".jsonl",
);
const blocks = (await readFile(transcript, "utf8"))
	.trim()
	.split("\n")
	.flatMap((line) => {
		const content = JSON.parse(line).message?.content;
		return Array.isArray(content) ? content : [];
	});
const protectedCalls = new Set(
	blocks
		.filter(
			(block) =>
				block.type === "tool_use" &&
				block.name === "mcp__jam_workspace__workspace_read" &&
				block.input?.root === "repository" &&
				block.input?.path === protectedPath,
		)
		.map((block) => block.id),
);
assert.ok(
	blocks.some(
		(block) =>
			block.type === "tool_result" &&
			protectedCalls.has(block.tool_use_id) &&
			block.is_error === true,
	),
	"The exact protected-path tool call must return an error",
);
console.log(JSON.stringify({ verified: true, protectedReadDenied: true }));
