import { createHash } from "node:crypto";
const login = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const sha = /^[a-f0-9]{40}$/;
export async function readProjectSource(
	repository: string,
	expectedId: number,
	profileRef: string | undefined,
	api: (path: string) => Promise<any>,
) {
	const base = "repos/" + repository;
	const repo = await api(base);
	if (
		repo.id !== expectedId ||
		!login.test(repo.owner?.login ?? "") ||
		!repo.default_branch
	)
		throw Error("Project profile repository mismatch");
	const head = await api(
		base + "/commits/" + encodeURIComponent(profileRef ?? repo.default_branch),
	);
	if (!sha.test(head.sha) || !sha.test(head.commit?.tree?.sha))
		throw Error("Project profile commit unavailable");
	async function entry(tree: string, name: string) {
		const data = await api(base + "/git/trees/" + tree);
		if (data.sha !== tree || data.truncated || !Array.isArray(data.tree))
			throw Error("Incomplete project profile tree");
		return data.tree.find((node: { path: string }) => node.path === name);
	}
	const folder = await entry(head.commit.tree.sha, ".jam-bot");
	let markdown = "";
	if (folder) {
		if (folder.mode !== "040000" || !sha.test(folder.sha))
			throw Error("Invalid project profile directory");
		const file = await entry(folder.sha, "VALUES.md");
		if (file) {
			if (
				file.mode !== "100644" ||
				!sha.test(file.sha) ||
				!Number.isInteger(file.size) ||
				file.size > 16384
			)
				throw Error("Invalid or oversized project profile");
			const blob = await api(base + "/git/blobs/" + file.sha);
			const bytes = Buffer.from(blob.content ?? "", "base64");
			if (
				blob.encoding !== "base64" ||
				bytes.length !== file.size ||
				createHash("sha1")
					.update("blob " + bytes.length + "\0")
					.update(bytes)
					.digest("hex") !== file.sha
			)
				throw Error("Project profile blob mismatch");
			markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		}
	}
	return { markdown, sha: head.sha as string, owner: String(repo.owner.login) };
}
