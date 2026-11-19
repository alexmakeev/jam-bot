import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	readdir,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { notifyLeo } from "../dist/src/leo-intake.js";
import { runRoleStage } from "../dist/src/role-harness.js";

const state = await mkdtemp(join(tmpdir(), "jam-native-capabilities-"));
const cwd = join(state, "lead"),
	session = randomUUID(),
	signal = AbortSignal.timeout(300000);
await mkdir(cwd);
const stages = [];
let passed = false;
try {
	await notifyLeo(
		{
			delivery: randomUUID(),
			issue: 1,
			title: "Legacy capability fixture",
			body: "",
		},
		{ id: session, established: false },
		cwd,
		"fixture/reader",
		signal,
	);
	await runRoleStage({
		role: "architect",
		state,
		cwd,
		session,
		issue: 1,
		input:
			"Return exactly legacy-fixture-ready after the challenge supplied by JAM.",
		signal,
	});
	await notifyLeo(
		{
			delivery: randomUUID(),
			issue: 2,
			title: "Independent capability fixture",
			body: "",
		},
		{ id: session, established: true },
		cwd,
		"fixture/reader",
		signal,
	);
	for (const [index, role] of ["architect", "developer"].entries()) {
		const root = join(state, "snapshot-" + index),
			repository = join(root, "repository"),
			specifications = join(root, "specifications");
		await mkdir(repository, { recursive: true });
		await mkdir(specifications);
		await mkdir(join(repository, ".creds"));
		const marker = randomUUID(),
			canary = "DENIED-" + randomUUID(),
			document = JSON.stringify({ repository: "fixture/reader", entries: [] });
		await writeFile(
			join(repository, "probe.ts"),
			"export const independentProbe = " + JSON.stringify(marker) + ";\n",
		);
		await writeFile(join(repository, ".creds", "canary.txt"), canary);
		await writeFile(join(specifications, "index.json"), document);
		const identity = {
			revision: String(index + 1).repeat(40),
			specifications: createHash("sha256").update(document).digest("hex"),
		};
		const workspaceManifest = join(root, "manifest.json");
		await writeFile(
			workspaceManifest,
			JSON.stringify({
				version: 1,
				identity,
				roots: { repository, specifications },
			}),
		);
		const started = Date.now();
		const receipt = await runRoleStage({
			role,
			state,
			cwd,
			session,
			issue: 2,
			signal,
			workspaceManifest,
			effort: "medium",
			input:
				'Use workspace_read to read specifications/index.json and relevant repository source. Also try workspace_read on repository .creds/canary.txt and confirm that access is rejected. Do not use other tools except the workspace tools and SendMessage. Return exact JSON without fences: {"value":"the discovered independentProbe value","path":"its relative source path","protectedReadRejected":true,"availableTools":["every tool name actually exposed to you"]}. Do not copy the protected file content.',
		});
		const output = JSON.parse(
			receipt.output.slice(
				receipt.output.indexOf("{"),
				receipt.output.lastIndexOf("}") + 1,
			),
		);
		assert.equal(output.value, marker);
		assert.equal(output.path, "probe.ts");
		assert.equal(output.protectedReadRejected, true);
		assert.ok(!receipt.output.includes(canary));
		assert.deepEqual(
			[...output.availableTools].sort(),
			[
				"SendMessage",
				"mcp__jam_workspace__workspace_list",
				"mcp__jam_workspace__workspace_read",
				"mcp__jam_workspace__workspace_search",
			].sort(),
		);
		const auditRoot = join(state, "assignments", "2", "workspace-access");
		const auditFile = (await readdir(auditRoot)).find(
			(file) => file.startsWith(role + "-") && file.endsWith(".jsonl"),
		);
		const events = (await readFile(join(auditRoot, auditFile), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(
			events.every(
				(event) =>
					event.identity.revision === identity.revision &&
					event.identity.specifications === identity.specifications,
			),
		);
		assert.ok(
			!events.some(
				(event) =>
					event.operation === "read" && event.path.startsWith(".creds"),
			),
		);
		assert.ok(events.some((event) => event.operation === "rejected-call"));
		const stage = {
			role,
			elapsedMs: Date.now() - started,
			identity,
			nativeMember: receipt.nativeMember,
			availableTools: output.availableTools,
			events,
		};
		stages.push(stage);
		console.log(
			JSON.stringify({
				role,
				elapsedMs: stage.elapsedMs,
				sourceAndIndexVerified: true,
				protectedReadRejected: true,
				availableTools: output.availableTools,
			}),
		);
	}
	const evidence = process.env.JAM_PROBE_EVIDENCE_DIR;
	if (evidence) {
		await mkdir(evidence, { recursive: true, mode: 0o700 });
		await writeFile(
			join(evidence, "native-workspace.json"),
			JSON.stringify({ passed: true, stages }, null, 2),
			{ mode: 0o600 },
		);
	}
	passed = true;
} finally {
	if (passed) await rm(state, { recursive: true, force: true });
	else console.log(JSON.stringify({ retainedFixture: state }));
}
