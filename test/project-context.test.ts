import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	projectContext,
	implementationInput,
} from "../src/developer-profile.js";
import { applyRoleFiles } from "../src/role-files.js";

test("architect-referenced implementation and adjacent tests are readable without granting edits", async () => {
	const tree = await realpath(
		await mkdtemp(join(tmpdir(), "jam-project-context-")),
	);
	try {
		await mkdir(join(tree, "src"));
		await mkdir(join(tree, "tests"));
		await writeFile(
			join(tree, "src/sum.ts"),
			"export const sum = (values: number[]) => values.reduce((x,y) => x+y,0);",
		);
		await writeFile(
			join(tree, "tests/sum.test.ts"),
			"import { sum } from '../src/sum.ts';",
		);
		await writeFile(join(tree, "src/unrelated.ts"), "private-unrelated-source");
		execFileSync("git", ["init", "--quiet", tree]);
		execFileSync("git", ["-C", tree, "add", "."]);
		const files = ["tests/sum.large.test.ts"];
		const brief = await projectContext(
			tree,
			files,
			"Check src/sum.ts and match tests/sum.test.ts.",
		);
		assert.match(brief, /export const sum =/);
		assert.match(brief, /import \{ sum \} from/);
		assert.doesNotMatch(brief, /private-unrelated-source/);
		await assert.rejects(
			applyRoleFiles(
				tree,
				files,
				JSON.stringify({
					files: [{ path: "src/sum.ts", content: "unexpected edit" }],
				}),
			),
		);
	} finally {
		await rm(tree, { recursive: true, force: true });
	}
});

test("a developer can read its whole previous output when correcting a larger approved source file", async () => {
	const tree = await realpath(
		await mkdtemp(join(tmpdir(), "jam-project-revision-")),
	);
	try {
		const source =
			"a".repeat(16000) + "retain-this-middle-line" + "b".repeat(16000);
		await writeFile(join(tree, "page.html"), source);
		execFileSync("git", ["init", "--quiet", tree]);
		execFileSync("git", ["-C", tree, "add", "."]);
		const context = await projectContext(tree, ["page.html"], "");
		const input = implementationInput(
			context,
			"approved edit",
			"s".repeat(30000),
			"a".repeat(30000),
			"fix alignment",
		);
		assert.ok(input.includes(source));
		assert.ok(Buffer.byteLength(input) <= 80000);
	} finally {
		await rm(tree, { recursive: true, force: true });
	}
});

test("independent context keeps oversized sources discoverable without copying them or credentials into the prompt", async () => {
	const tree = await realpath(
		await mkdtemp(join(tmpdir(), "jam-context-bounded-")),
	);
	try {
		await writeFile(join(tree, "large.ts"), "large-source-marker".repeat(6000));
		await writeFile(join(tree, ".env"), "SECRET-CANARY");
		execFileSync("git", ["init", "--quiet", tree]);
		execFileSync("git", ["-C", tree, "add", "--force", "."]);
		const context = await projectContext(tree, ["large.ts", ".env"], "", true);
		assert.match(context, /large\.ts/);
		assert.match(context, /Content omitted/);
		assert.doesNotMatch(context, /SECRET-CANARY|large-source-marker/);
		assert.ok(Buffer.byteLength(context) < 6000);
	} finally {
		await rm(tree, { recursive: true, force: true });
	}
});
