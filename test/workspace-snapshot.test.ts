import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { git } from "../src/profile-checkout.js";
import {
	createWorkspaceSnapshot,
	localSpecificationIndex,
} from "../src/workspace-snapshot.js";
import { digestOf, specName } from "../src/specification-upload.js";

test("workspace pins committed code and verified local planned specs without network access", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-snapshot-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const store = join(state, "project");
	await mkdir(store);
	await git(store, "init");
	await writeFile(join(store, "code.ts"), "export const version=1;\n");
	await writeFile(
		join(store, ".gitattributes"),
		"hidden.md export-ignore\nsubstituted.md export-subst\n",
	);
	await writeFile(
		join(store, "hidden.md"),
		"Required despite archive exclusion",
	);
	await writeFile(join(store, "substituted.md"), "$Format:%H$");
	await git(store, "add", ".");
	await git(store, "commit", "-m", "baseline");
	const revision = await git(store, "rev-parse", "HEAD");
	await writeFile(join(store, "code.ts"), "uncommitted mutation");
	const db = new DatabaseSync(join(state, "intake.sqlite"));
	db.exec(
		"CREATE TABLE intake(issue,title,state,workerState,action,lockVerified,actorId,authorId,typeId,approvalSource); INSERT INTO intake VALUES(7,'Future API','queued','pending','task',1,1,1,3,'typed'); INSERT INTO intake VALUES(8,'Unapproved','queued','pending','task',0,1,1,3,'typed')",
	);
	db.close();
	const specs = new DatabaseSync(join(state, "specifications.sqlite"));
	specs.exec("CREATE TABLE publications(issue,digest,stage,receipt)");
	const text = "# Planned API\nNot implemented yet.\n",
		digest = digestOf(text),
		name = specName(7, digest);
	specs
		.prepare("INSERT INTO publications VALUES(?,?,?,?)")
		.run(7, digest, "artifact", 99);
	specs.close();
	const attachments = join(state, "assignments", "7", "attachments");
	await mkdir(attachments, { recursive: true });
	await writeFile(
		join(state, "assignments", "7", "architect.json"),
		JSON.stringify({ output: text }),
	);
	await writeFile(join(attachments, name), text);
	const unverified = await localSpecificationIndex(state, "example/project");
	assert.equal(unverified.entries[0]?.specifications.length ?? 0, 0);
	await writeFile(
		join(attachments, name + ".verified.json"),
		JSON.stringify({
			name,
			sha256: digest,
			artifact: 99,
			repository: "example/project",
			repoId: 1,
			publisher: 2,
			revision,
			url: "https://github.com/example/project/issues/7/artifacts/99",
		}),
	);
	const snapshot = await createWorkspaceSnapshot(
		state,
		store,
		revision,
		"example/project",
	);
	const manifest = JSON.parse(await readFile(snapshot.manifestPath, "utf8"));
	assert.equal(
		await readFile(join(manifest.roots.repository, "code.ts"), "utf8"),
		"export const version=1;\n",
	);
	assert.equal(
		await readFile(join(manifest.roots.repository, "hidden.md"), "utf8"),
		"Required despite archive exclusion",
	);
	assert.equal(
		await readFile(join(manifest.roots.repository, "substituted.md"), "utf8"),
		"$Format:%H$",
	);
	const index = JSON.parse(
		await readFile(join(manifest.roots.specifications, "index.json"), "utf8"),
	);
	assert.equal(index.entries.length, 1);
	assert.equal(index.entries[0].status, "pending");
	assert.equal(index.entries[0].specifications[0].current, true);
	const intake = new DatabaseSync(join(state, "intake.sqlite"));
	intake.exec("UPDATE intake SET workerState='complete' WHERE issue=7");
	intake.close();
	assert.equal(
		(await localSpecificationIndex(state, "example/project")).entries[0]
			?.status,
		"awaiting integration",
	);
	assert.equal(
		await readFile(join(manifest.roots.specifications, name), "utf8"),
		text,
	);
	await writeFile(join(attachments, name), "tampered");
	await assert.rejects(
		localSpecificationIndex(state, "example/project"),
		/digest/,
	);
});
