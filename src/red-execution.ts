import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const unitPath = (path: string) =>
	/^(?:test|tests)\/.*\.test\.[cm]?[jt]s$/.test(path);
export async function redExecutionTree(
	store: string,
	base: string,
	testRevision: string,
): Promise<string> {
	if (![base, testRevision].every((value) => /^[a-f0-9]{40}$/.test(value)))
		throw Error("Invalid RED execution revision");
	const directory = await mkdtemp(join(tmpdir(), "jam-red-index-"));
	const options = {
		cwd: store,
		env: { ...process.env, GIT_INDEX_FILE: join(directory, "index") },
		maxBuffer: 16 * 1024 * 1024,
	};
	const args = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
	const git = async (...command: string[]) =>
		(await run("git", [...args, ...command], options)).stdout;
	try {
		await git("read-tree", base);
		const entries = async (revision: string) =>
			(await git("ls-tree", "-r", "-z", revision))
				.split("\0")
				.filter(Boolean)
				.filter((entry) => unitPath(entry.slice(entry.indexOf("\t") + 1)));
		const remove = (await entries(base))
			.map(
				(entry) =>
					"0 " +
					"0".repeat(40) +
					"\t" +
					entry.slice(entry.indexOf("\t") + 1) +
					"\0",
			)
			.join("");
		const insert = (await entries(testRevision))
			.map((entry) => entry.replace(/^([0-9]+) blob /, "$1 ") + "\0")
			.join("");
		await new Promise<void>((resolve, reject) => {
			const child = execFile(
				"git",
				[...args, "update-index", "-z", "--index-info"],
				options,
				(error) => (error ? reject(error) : resolve()),
			);
			child.stdin!.on("error", reject);
			child.stdin!.end(remove + insert);
		});
		return (await git("write-tree")).trim();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
