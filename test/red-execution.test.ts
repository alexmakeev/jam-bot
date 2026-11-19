import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.js";
import { redExecutionTree } from "../src/red-execution.js";

test("RED tree uses baseline production and the exact candidate test set including deletions", async (t) => {
	const store = await mkdtemp(join(tmpdir(), "jam-red-tree-"));
	t.after(() => rm(store, { recursive: true, force: true }));
	await git(store, "init", "-q");
	await git(store, "config", "user.email", "test@example.invalid");
	await git(store, "config", "user.name", "Test");
	await mkdir(join(store, "src"));
	await mkdir(join(store, "test"));
	await writeFile(join(store, "src/main.ts"), "export const value=0;");
	await writeFile(join(store, "test/keep.test.ts"), "baseline test");
	await writeFile(join(store, "test/deleted.test.ts"), "deleted baseline test");
	await git(store, "add", ".");
	await git(store, "commit", "-qm", "baseline");
	const base = await git(store, "rev-parse", "HEAD");
	await writeFile(join(store, "src/main.ts"), "export const value=1;");
	await writeFile(join(store, "test/keep.test.ts"), "candidate assertion");
	await writeFile(join(store, "test/new.test.mjs"), "new regression");
	await rm(join(store, "test/deleted.test.ts"));
	await git(store, "add", ".");
	await git(store, "commit", "-qm", "candidate");
	const candidate = await git(store, "rev-parse", "HEAD"),
		index = await git(store, "write-tree");
	await writeFile(join(store, "src/main.ts"), "uncommitted owner work");
	const tree = await redExecutionTree(store, base, candidate);
	assert.equal(
		await git(store, "show", tree + ":src/main.ts"),
		"export const value=0;",
	);
	assert.equal(
		await git(store, "show", tree + ":test/keep.test.ts"),
		"candidate assertion",
	);
	assert.equal(
		await git(store, "show", tree + ":test/new.test.mjs"),
		"new regression",
	);
	assert.equal(
		await git(store, "ls-tree", tree, "--", "test/deleted.test.ts"),
		"",
	);
	assert.equal(await git(store, "write-tree"), index);
	assert.equal(await git(store, "rev-parse", "HEAD"), candidate);
	assert.equal(
		await readFile(join(store, "src/main.ts"), "utf8"),
		"uncommitted owner work",
	);
	assert.equal(await redExecutionTree(store, base, candidate), tree);
	assert.notEqual(tree, index);
});

test("RED execution rejects non-object revision inputs before invoking Git", async () => {
	await assert.rejects(
		redExecutionTree("/missing", "HEAD", "a".repeat(40)),
		/Invalid RED execution revision/,
	);
});
