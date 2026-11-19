import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The host re-fetches and authorizes the GitHub comment before acting on this wake-up.
export async function storeReleaseApprovalHint(
	root: string,
	repoId: number,
	repository: string,
	issue: number,
	comment: {
		id?: number;
		body?: string;
		user?: { type?: string; id?: number };
	},
	senderId: number,
) {
	if (
		!Number.isSafeInteger(senderId) ||
		senderId <= 0 ||
		!Number.isSafeInteger(issue) ||
		issue <= 0 ||
		!Number.isSafeInteger(comment?.id) ||
		Number(comment.id) <= 0 ||
		comment.user?.type !== "User" ||
		comment.user.id !== senderId ||
		typeof comment.body !== "string"
	)
		return;
	const prefix = "Approve JAM-Bot stable release of " + repository + " at ";
	if (!comment.body.startsWith(prefix)) return;
	const suffix = comment.body.slice(prefix.length);
	if (!/^[0-9a-f]{40}\.$/.test(suffix)) return;
	const dir = join(root, "release-approvals", String(repoId));
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, "." + randomUUID());
	await writeFile(
		tmp,
		JSON.stringify({
			repoId,
			issue,
			commentId: comment.id,
			sha: suffix.slice(0, -1),
		}),
		{ flag: "wx", mode: 0o600 },
	);
	await rename(tmp, join(dir, comment.id + ".json"));
}
