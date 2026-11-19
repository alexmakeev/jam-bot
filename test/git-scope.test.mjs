import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	fetchValidationBase,
	overlayRedTests,
	verifyCandidateScope,
} from "../scripts/macos/git-scope.mjs";

const run = promisify(execFile);
async function repository(t) {
	const directory = await mkdtemp(join(tmpdir(), "jam-broker-scope-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const git = async (args) =>
		(
			await run(
				"git",
				[
					"-c",
					"user.name=JAM Test",
					"-c",
					"user.email=jam@example.test",
					"-c",
					"commit.gpgsign=false",
					"-c",
					"core.hooksPath=/dev/null",
					...args,
				],
				{ cwd: directory },
			)
		).stdout.trimEnd();
	const head = () => git(["rev-parse", "HEAD"]);
	const commit = async (file, content) => {
		await writeFile(join(directory, file), content);
		await git(["add", "--", file]);
		await git(["commit", "-m", "Update " + file]);
		return head();
	};
	await git(["init", "-b", "dev"]);
	const original = await commit("README.md", "Baseline\n");
	return { directory, git, head, commit, original };
}

test("a stale-base feature integrates onto current dev without claiming prior dev files", async (t) => {
	const { git, head, commit, original } = await repository(t);
	const latest = await commit("minimum.ts", "Minimum\n");
	await git(["switch", "-c", "maximum", original]);
	const feature = await commit("maximum.ts", "Maximum\n");
	await git(["switch", "dev"]);
	await git(["merge", "--no-ff", "--no-edit", feature]);
	const candidate = await head();
	const files = new Set(["maximum.ts"]);
	for (const action of ["test", "publish"])
		await verifyCandidateScope(
			git,
			{ action, base: latest, sha: candidate },
			files,
		);
	await assert.rejects(
		verifyCandidateScope(
			git,
			{ action: "test-head", base: latest, sha: candidate },
			files,
		),
		/outside approved file scope/,
	);
	await verifyCandidateScope(
		git,
		{ action: "test-red", base: original, sha: feature },
		files,
	);
	await verifyCandidateScope(
		git,
		{ action: "test", base: original, sha: candidate },
		new Set(["minimum.ts", "maximum.ts"]),
	);
});

test("a group of stale heads inherits only paths already present on the dev spine", async (t) => {
	const { git, head, commit, original } = await repository(t);
	const base = await commit("published.ts", "Already published\n");
	await git(["switch", "-c", "first", original]);
	const first = await commit("first result.ts", "First work card\n");
	await git(["switch", "-c", "second", original]);
	const second = await commit("second.ts", "Second work card\n");
	await git(["switch", "dev"]);
	await git(["merge", "--no-ff", "--no-edit", first]);
	await git(["merge", "--no-ff", "--no-edit", second]);
	const files = new Set(["first result.ts", "second.ts"]);
	await verifyCandidateScope(
		git,
		{ action: "publish", base, sha: await head() },
		files,
	);
});

test("merges away from the exact dev spine retain the strict parent checks", async (t) => {
	const { git, head, commit, original } = await repository(t);
	const base = await commit("published.ts", "Already published\n");
	await git(["switch", "-c", "feature", original]);
	await commit("approved.ts", "Approved work\n");
	await git(["merge", "--no-ff", "--no-edit", base]);
	const sideMerge = await head();
	const files = new Set(["approved.ts"]);
	await assert.rejects(
		verifyCandidateScope(git, { action: "test", base, sha: sideMerge }, files),
		/outside approved file scope/,
	);

	const combinedTree = await git(["rev-parse", sideMerge + "^{tree}"]);
	const outerMerge = await git([
		"commit-tree",
		combinedTree,
		"-p",
		base,
		"-p",
		sideMerge,
		"-m",
		"Combine",
	]);
	await assert.rejects(
		verifyCandidateScope(git, { action: "test", base, sha: outerMerge }, files),
		/outside approved file scope/,
	);

	const baseTree = await git(["rev-parse", base + "^{tree}"]);
	const redundantMerge = await git([
		"commit-tree",
		baseTree,
		"-p",
		base,
		"-p",
		original,
		"-m",
		"Merge previous ancestor",
	]);
	await assert.rejects(
		verifyCandidateScope(
			git,
			{ action: "publish", base, sha: redundantMerge },
			files,
		),
		/outside approved file scope/,
	);
	await verifyCandidateScope(git, { action: "test", base, sha: base }, files);
});

test("publication checks the new side history even when the final net delta is approved", async (t) => {
	const { directory, git, head, commit, original } = await repository(t);
	const latest = await commit("minimum.ts", "Minimum\n");
	await git(["switch", "-c", "maximum", original]);
	await commit("README.md", "Out-of-scope intermediate change\n");
	await commit("README.md", "Baseline\n");
	const feature = await commit("maximum.ts", "Maximum\n");
	await git(["switch", "dev"]);
	await git(["merge", "--no-ff", "--no-edit", feature]);
	const files = new Set(["maximum.ts"]);
	await assert.rejects(
		verifyCandidateScope(
			git,
			{ action: "publish", base: latest, sha: await head() },
			files,
		),
		/outside approved file scope/,
	);

	await git(["switch", "-c", "approved-side", original]);
	const approved = await commit("maximum.ts", "Maximum\n");
	await git(["switch", "-c", "resolution", latest]);
	await git(["merge", "--no-ff", "--no-commit", approved]);
	await writeFile(
		join(directory, "README.md"),
		"Out-of-scope merge resolution\n",
	);
	await git(["add", "--", "README.md"]);
	await git(["commit", "--no-edit"]);
	await assert.rejects(
		verifyCandidateScope(
			git,
			{ action: "test", base: latest, sha: await head() },
			files,
		),
		/outside approved file scope/,
	);
});

test("renames require approval for the deleted path as well as the destination", async (t) => {
	const { git, head, original } = await repository(t);
	await git(["mv", "README.md", "approved.md"]);
	await git(["commit", "-m", "Rename the file"]);
	await assert.rejects(
		verifyCandidateScope(
			git,
			{ action: "publish", base: original, sha: await head() },
			new Set(["approved.md"]),
		),
		/outside approved file scope/,
	);
});

test("read-only worker validation retains exact ancestor bases as dev advances", async (t) => {
	const { directory, git, commit, original } = await repository(t);
	const remote = join(directory, "remote.git");
	await git(["init", "--bare", remote]);
	await git(["remote", "add", "origin", remote]);
	await git(["push", "origin", "dev"]);
	const latest = await commit("peer.ts", "Previously published peer\n");
	await git(["push", "origin", "dev"]);
	const unexpectedDefault = () => {
		throw Error("Unexpected default-branch lookup");
	};
	for (const action of ["test-red", "test-head"]) {
		await fetchValidationBase(
			git,
			{ action, base: original, expected: original },
			latest,
			unexpectedDefault,
		);
		assert.equal(await git(["rev-parse", "refs/heads/base"]), latest);
	}
	for (const action of ["test", "publish"]) {
		await assert.rejects(
			fetchValidationBase(
				git,
				{ action, base: original, expected: original },
				latest,
				unexpectedDefault,
			),
			/Remote dev changed/,
		);
		await assert.rejects(
			fetchValidationBase(
				git,
				{ action, base: original, expected: latest },
				latest,
				unexpectedDefault,
			),
			/Candidate base is stale/,
		);
		await assert.rejects(
			fetchValidationBase(
				git,
				{ action, base: original, expected: original },
				original,
				unexpectedDefault,
			),
			/Candidate base is stale/,
		);
		await fetchValidationBase(
			git,
			{ action, base: latest, expected: latest },
			latest,
			unexpectedDefault,
		);
	}
	const replacement = await git([
		"commit-tree",
		latest + "^{tree}",
		"-m",
		"Unrelated dev root",
	]);
	await git(["push", "--force", "origin", replacement + ":refs/heads/dev"]);
	await git(["update-ref", "-d", "refs/heads/base"]);
	await assert.rejects(
		fetchValidationBase(
			git,
			{ action: "test-red", base: original, expected: original },
			latest,
			unexpectedDefault,
		),
		/merge-base/,
	);
});

test("empty dev uses the authenticated default ref and preserves its exact integration gate", async (t) => {
	const { directory, git, commit, original } = await repository(t);
	const remote = join(directory, "remote.git");
	await git(["init", "--bare", remote]);
	await git(["remote", "add", "origin", remote]);
	const tip = await commit("main.ts", "Default branch advances\n");
	await git(["push", "origin", "HEAD:refs/heads/main"]);
	const defaultBranch = async () => "main";
	await fetchValidationBase(
		git,
		{ action: "test-red", base: original, expected: "" },
		"",
		defaultBranch,
	);
	await assert.rejects(
		fetchValidationBase(
			git,
			{ action: "test", base: original, expected: "" },
			"",
			defaultBranch,
		),
		/Candidate base is stale/,
	);
	await fetchValidationBase(
		git,
		{ action: "test", base: tip, expected: "" },
		"",
		defaultBranch,
	);
	const replacement = await git([
		"commit-tree",
		tip + "^{tree}",
		"-m",
		"Unrelated default root",
	]);
	await git(["push", "--force", "origin", replacement + ":refs/heads/main"]);
	await git(["update-ref", "-d", "refs/heads/base"]);
	await assert.rejects(
		fetchValidationBase(
			git,
			{ action: "test-head", base: original, expected: "" },
			"",
			defaultBranch,
		),
		/merge-base/,
	);
});

test("refined RED overlays candidate tests on original production even after dev adds files", async (t) => {
	const { directory, git, commit } = await repository(t);
	await mkdir(join(directory, "test"));
	await commit("implementation.ts", "Original implementation\n");
	await commit("test/previous.test.mjs", "Original test\n");
	const base = await commit("test/removed.test.mjs", "Old candidate test\n");
	await commit("peer.ts", "Concurrent production\n");
	await commit("test/peer.test.mjs", "Concurrent test\n");

	await git(["switch", "-c", "candidate", base]);
	await commit(
		"implementation.ts",
		"Refined production must stay out of RED\n",
	);
	await commit("test/previous.test.mjs", "Refined test\n");
	await git(["rm", "--", "test/removed.test.mjs"]);
	await git(["commit", "-m", "Remove obsolete test"]);
	const candidate = await commit("test/new.test.mjs", "New test\n");
	const worktree = join(directory, "red-worktree");
	await git(["worktree", "add", "--detach", worktree, base]);
	const inWorktree = (args) => git(["-C", worktree, ...args]);
	await overlayRedTests(git, inWorktree, candidate);
	assert.deepEqual(
		(await inWorktree(["ls-files", "-z"])).split("\0").filter(Boolean),
		[
			"README.md",
			"implementation.ts",
			"test/new.test.mjs",
			"test/previous.test.mjs",
		],
	);
	assert.equal(
		await readFile(join(worktree, "implementation.ts"), "utf8"),
		"Original implementation\n",
	);
	assert.equal(
		await readFile(join(worktree, "test/previous.test.mjs"), "utf8"),
		"Refined test\n",
	);
	assert.equal(
		await readFile(join(worktree, "test/new.test.mjs"), "utf8"),
		"New test\n",
	);
	assert.deepEqual(
		(await inWorktree(["diff", "--name-only", "--cached", base])).split("\n"),
		["test/new.test.mjs", "test/previous.test.mjs", "test/removed.test.mjs"],
	);
});
