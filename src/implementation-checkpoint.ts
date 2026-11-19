import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, readJson } from "./storage.js";
import { git } from "./profile-checkout.js";
import { finishRoleFiles, planRoleFiles } from "./role-files.js";
import { Journal } from "./intake-journal.js";
import type { checkout } from "./profile-checkout.js";
interface Intent {
	parent: string;
	files: Awaited<ReturnType<typeof planRoleFiles>>;
	tree?: string;
	sha?: string;
}
export interface ImplementationCorrection {
	sha: string;
	attempt: number;
	feedback: string;
	reviewOnly?: boolean;
	integrationHead?: string;
	reviewHead?: string;
}

export async function checkpointImplementationCorrection(
	state: string,
	issue: number,
	project: Awaited<ReturnType<typeof checkout>>,
	correction: ImplementationCorrection,
) {
	const journal = new Journal(join(state, "intake.sqlite"));
	try {
		if (!journal.specificationCheckpoint(issue))
			throw Error("Missing active implementation checkpoint");
		await atomicJson(
			join(state, "assignments", String(issue), "correction.json"),
			{ project, ...correction },
		);
		journal.checkpointSpecification(
			issue,
			JSON.stringify({ ...project, correcting: true }),
		);
	} finally {
		journal.db.close();
	}
}

export async function implementationCommit(
	tree: string,
	path: string,
	issue: number,
	scope: string[],
	propose: () => Promise<string>,
	authorize: () => Promise<void>,
	allowNoChanges = false,
) {
	let intent = await readJson<Intent>(path).catch(
		(e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		},
	);
	tree = await realpath(tree);
	const head = await git(tree, "rev-parse", "HEAD");
	if (!intent) {
		if (await git(tree, "status", "--porcelain"))
			throw Error("Unexpected edits before developer handoff");
		const output = await propose();
		for (const file of scope) {
			let parent = tree;
			for (const part of file.split("/").slice(0, -1)) {
				parent = join(parent, part);
				await mkdir(parent).catch((e: NodeJS.ErrnoException) => {
					if (e.code !== "EEXIST") throw e;
				});
				if ((await realpath(parent)) !== parent)
					throw Error("Unsafe checkout directory");
			}
		}
		const files = await planRoleFiles(tree, scope, output, allowNoChanges);
		if (!files.length) {
			await authorize();
			await atomicJson(path, { parent: head, files, sha: head });
			return head;
		}
		intent = { parent: head, files };
		await atomicJson(path, intent);
	}
	await authorize();
	if (!intent.files.length) {
		if (
			!allowNoChanges ||
			head !== intent.parent ||
			(await git(tree, "status", "--porcelain"))
		)
			throw Error("Invalid evidence-only correction checkpoint");
		return head;
	}
	if (
		intent.files.some(
			(f) => !scope.includes(f.path) || f.target !== join(tree, f.path),
		)
	)
		throw Error("Recorded work differs from approved scope");
	if (head !== intent.parent) {
		if (
			(intent.sha && head !== intent.sha) ||
			!intent.tree ||
			(await git(tree, "rev-parse", "HEAD^")) !== intent.parent ||
			(await git(tree, "rev-parse", "HEAD^{tree}")) !== intent.tree ||
			(await git(tree, "status", "--porcelain"))
		)
			throw Error(
				"Unexpected worktree revision during implementation recovery",
			);
		return head;
	}
	const paths = await finishRoleFiles(intent.files);
	await git(tree, "add", "--", ...paths);
	const changed = (await git(tree, "diff", "--cached", "--name-only", "-z"))
		.split("\0")
		.filter(Boolean);
	if (
		!changed.length ||
		changed.some((file) => !paths.includes(file)) ||
		(await git(tree, "ls-files", "--others", "--exclude-standard")) ||
		(await git(tree, "diff", "--name-only"))
	)
		throw Error("Unrecognized or missing changes during developer commit");
	intent.tree = await git(tree, "write-tree");
	await atomicJson(path, intent);
	await git(tree, "commit", "-m", "Implement work card " + issue);
	intent.sha = await git(tree, "rev-parse", "HEAD");
	await atomicJson(path, intent);
	return intent.sha;
}
