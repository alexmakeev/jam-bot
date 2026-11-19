import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceReader } from "../src/workspace-reader.js";

test("workspace tools discover omitted files, paginate large reads and reject protected paths and escapes", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "jam-workspace-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const repository = join(base, "repo"),
		specifications = join(base, "specs");
	await mkdir(repository);
	await mkdir(specifications);
	await writeFile(join(base, "outside.txt"), "private outside data");
	await writeFile(join(repository, "README.md"), "entry point");
	await writeFile(
		join(repository, "hidden-context.ts"),
		"x".repeat(70000) + "\nindependent-fixture-42",
	);
	await writeFile(join(repository, ".env"), "PRIVATE_KEY=canary");
	await symlink(join(base, "outside.txt"), join(repository, "escape.txt"));
	await writeFile(
		join(specifications, "index.json"),
		JSON.stringify({ issue: 9, status: "planned", spec: "spec-9.md" }),
	);
	await writeFile(join(specifications, "spec-9.md"), "planned-api-change");
	const reader = new WorkspaceReader({
		version: 1,
		identity: { revision: "a".repeat(40), specifications: "b".repeat(64) },
		roots: { repository, specifications },
	});
	const first = await reader.list("repository", "", 0, 1);
	assert.equal(first.entries.length, 1);
	assert.equal(first.total, 2);
	assert.equal(first.next, 1);
	const found = await reader.search("repository", "independent-fixture-42");
	assert.equal(found.matches[0]?.path, "hidden-context.ts");
	const chunk = await reader.read("repository", "hidden-context.ts", 69990, 40);
	assert.match(chunk.text, /independent-fixture-42/);
	assert.equal(chunk.next, null);
	assert.match(
		(await reader.read("specifications", "index.json")).text,
		/planned/,
	);
	for (const path of ["../outside.txt", "/etc/passwd", ".env", "escape.txt"])
		await assert.rejects(reader.read("repository", path));
	await writeFile(
		join(repository, "matches.ts"),
		"unique-search-token\nunique-search-token\nunique-search-token",
	);
	const matches: number[] = [];
	let offset = 0,
		lineOffset = 0;
	for (let page = 0; page < 10; page++) {
		const result = await reader.search(
			"repository",
			"unique-search-token",
			"",
			offset,
			1,
			lineOffset,
		);
		matches.push(...result.matches.map((match) => match.line));
		if (result.next === null) break;
		offset = result.next;
		lineOffset = result.nextLine;
	}
	assert.deepEqual(matches, [1, 2, 3]);
});
