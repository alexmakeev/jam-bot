import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { git } from "./profile-checkout.js";
import { atomicJson, readJson } from "./storage.js";
interface Assembly {
	base: string;
	expected: string;
	heads: string[];
	current: string;
	index: number;
	expectedTree?: string;
}
export async function assembleCandidate(
	store: string,
	dir: string,
	seed: { sha: string; dev?: string },
	heads: string[],
) {
	const path = join(dir, "assembly.json"),
		tree = join(dir, "worktree");
	let saved = await readJson<Assembly>(path).catch(
		(e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		},
	);
	if (!saved) {
		if (await realpath(tree).catch(() => undefined))
			throw Error("Unidentified integration worktree needs reconciliation");
		saved = {
			base: seed.sha,
			expected: seed.dev ?? "",
			heads,
			current: seed.sha,
			index: 0,
		};
		await atomicJson(path, saved);
	}
	if (
		JSON.stringify(saved.heads) !== JSON.stringify(heads) ||
		saved.base !== seed.sha ||
		saved.expected !== (seed.dev ?? "")
	)
		throw Error("Integration input changed during assembly");
	if (!(await realpath(tree).catch(() => undefined)))
		await git(store, "worktree", "add", "--detach", tree, saved.current);
	for (; saved.index < heads.length; ) {
		const next = heads[saved.index]!,
			prior = saved.current,
			head = await git(tree, "rev-parse", "HEAD");
		if (head === prior) {
			const mergeBase = await git(tree, "merge-base", prior, next);
			if (mergeBase === prior || mergeBase === next) {
				if (await git(tree, "status", "--porcelain"))
					throw Error("Unexpected worktree changes before integration");
				if (mergeBase !== next) await git(tree, "merge", "--ff-only", next);
			} else {
				const merging = await git(
					tree,
					"rev-parse",
					"-q",
					"--verify",
					"MERGE_HEAD",
				).catch(() => "");
				if (merging && merging !== next)
					throw Error("Unexpected merge in recovered batch");
				if (!merging) {
					if (await git(tree, "status", "--porcelain"))
						throw Error("Unexpected changes before merge");
					await git(tree, "merge", "--no-commit", "--no-ff", next);
				}
				if (
					(await git(tree, "ls-files", "-u")) ||
					(await git(tree, "diff", "--name-only")) ||
					(await git(tree, "ls-files", "--others", "--exclude-standard"))
				)
					throw Error("Unresolved integration worktree");
				const index = await git(tree, "write-tree");
				if (merging && (!saved.expectedTree || saved.expectedTree !== index))
					throw Error("Interrupted merge index needs reconciliation");
				saved.expectedTree = index;
				await atomicJson(path, saved);
				await git(tree, "commit", "--no-edit");
			}
		}
		const actual = await git(tree, "rev-parse", "HEAD");
		if (actual === next) {
			if ((await git(tree, "merge-base", prior, next)) !== prior)
				throw Error("Unexpected fast-forward");
		} else if (actual === prior) {
			if ((await git(tree, "merge-base", prior, next)) !== next)
				throw Error("Missing integration input");
		} else if (
			!saved.expectedTree ||
			(await git(tree, "show", "-s", "--format=%P", actual)) !==
				prior + " " + next ||
			(await git(tree, "rev-parse", actual + "^{tree}")) !== saved.expectedTree
		)
			throw Error("Unrecognized integration commit");
		if (await git(tree, "status", "--porcelain"))
			throw Error("Unexpected integration worktree edits");
		saved.index++;
		saved.current = actual;
		delete saved.expectedTree;
		await atomicJson(path, saved);
	}
	return { sha: saved.current, base: saved.base, expected: saved.expected };
}
