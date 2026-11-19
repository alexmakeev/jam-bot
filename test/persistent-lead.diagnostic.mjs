import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	PersistentNativeLead,
	recoverPersistentDispatch,
} from "../dist/src/native-persistent-lead.js";
import { nativeLeadOccupied } from "../dist/src/native-lead.js";

const state = await mkdtemp("/tmp/jam-persistent-lead-"),
	cwd = join(state, "lead");
await mkdir(cwd);
const lead = await PersistentNativeLead.start({
	state,
	cwd,
	model: "claude-opus-5-5",
	effort: "medium",
	signal: AbortSignal.timeout(240000),
});
const completed = [];
console.log(JSON.stringify({ state, session: lead.session }));
try {
	assert.equal(await nativeLeadOccupied(state), true);
	for (const [name, issue, revision] of [
		["architect", 1, "a"],
		["manager-2", 2, "b"],
		["architect", 2, "c"],
	]) {
		const challenge = randomUUID(),
			marker = randomUUID();
		const repository = join(state, revision),
			specifications = join(repository, "specs");
		await mkdir(specifications, { recursive: true });
		await writeFile(join(repository, "marker.txt"), marker);
		const workspaceManifest = join(state, revision + ".json");
		await writeFile(
			workspaceManifest,
			JSON.stringify({
				version: 1,
				identity: {
					revision: revision.repeat(40),
					specifications: revision.repeat(64),
				},
				roots: { repository, specifications },
			}),
		);
		const receipt = await lead.dispatch({
			name,
			issue,
			challenge,
			workspaceManifest,
			input:
				"Read marker.txt from the repository root with workspace_read. Send exactly the challenge token on the first line and the exact file text on the second line. Do not add code fences or other text.",
		});
		assert.equal(receipt.output.trim(), marker);
		completed.push({ issue, challenge, receipt });
	}
	assert.equal(completed[0].receipt.developer, completed[2].receipt.developer);
	assert.notEqual(
		completed[0].receipt.developer,
		completed[1].receipt.developer,
	);
} finally {
	await lead.close();
}
assert.equal(await nativeLeadOccupied(state), false);
for (const { issue, challenge, receipt } of completed) {
	assert.deepEqual(
		(await recoverPersistentDispatch(state, issue, challenge))?.receipt,
		receipt,
	);
	await assert.rejects(
		recoverPersistentDispatch(state, issue + 1, challenge),
		/approved checkpoint/,
	);
}
const journal = join(state, "native-persistent-dispatches");
const saved = JSON.parse(
	await readFile(join(journal, completed[0].challenge + ".json"), "utf8"),
);
const incomplete = randomUUID();
await writeFile(
	join(journal, incomplete + ".json"),
	JSON.stringify({
		...saved,
		challenge: incomplete,
		prompt: saved.prompt.replaceAll(saved.challenge, incomplete),
		request: saved.request.replaceAll(saved.challenge, incomplete),
	}),
);
assert.deepEqual(
	await recoverPersistentDispatch(state, saved.issue, incomplete),
	{ attempted: true },
);
console.log(
	JSON.stringify({
		verified: true,
		sameArchitectAcrossRevisions: true,
		dispatchesRecoveredAfterLeadExit: completed.length,
		unsentIntentRemainedUncertain: true,
	}),
);
