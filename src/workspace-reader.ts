import { constants } from "node:fs";
import { appendFile, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import type { WorkspaceBinding } from "./workspace-binding.js";

export interface WorkspaceManifest {
	version: 1;
	identity: { revision: string; specifications: string };
	roots: { repository: string; specifications: string };
	audit?: string;
	binding?: WorkspaceBinding;
}
type Root = keyof WorkspaceManifest["roots"];
const forbidden = new Set([
	".git",
	".creds",
	".ssh",
	".codex",
	".claude",
	".gemini",
	".npmrc",
]);
export function permitted(path: string) {
	return path
		.split("/")
		.every(
			(part) =>
				!forbidden.has(part) &&
				!/^\.env(?:\.|$)/.test(part) &&
				!/\.(?:pem|key)$/i.test(part),
		);
}
function clean(path: string) {
	if (
		typeof path !== "string" ||
		path.includes("\0") ||
		path.includes("\\") ||
		isAbsolute(path) ||
		path.split("/").some((p) => p === ".." || p === ".")
	)
		throw Error("Invalid workspace path");
	if (!permitted(path)) throw Error("Protected workspace path");
	return path;
}
function bound(
	value: number | undefined,
	defaultValue: number,
	maximum: number,
) {
	const n = value ?? defaultValue;
	if (!Number.isSafeInteger(n) || n < 0 || n > maximum)
		throw Error("Invalid workspace range");
	return n;
}

export class WorkspaceReader {
	constructor(readonly manifest: WorkspaceManifest) {}
	private async target(root: Root, path: string) {
		if (!Object.hasOwn(this.manifest.roots, root))
			throw Error("Unknown workspace root");
		const base = await realpath(this.manifest.roots[root]);
		const target = await realpath(join(base, clean(path)));
		const part = relative(base, target);
		if (
			part === ".." ||
			part.startsWith(".." + sep) ||
			isAbsolute(part) ||
			!permitted(part.split(sep).join("/"))
		)
			throw Error("Workspace path escapes its root");
		return target;
	}
	private async record(operation: string, root: Root, path: string, bytes = 0) {
		if (this.manifest.audit)
			await appendFile(
				this.manifest.audit,
				JSON.stringify({
					at: new Date().toISOString(),
					identity: this.manifest.identity,
					binding: this.manifest.binding,
					operation,
					root,
					path,
					bytes,
				}) + "\n",
				{ mode: 0o600 },
			);
	}
	async list(root: Root, path = "", offset = 0, limit = 100) {
		offset = bound(offset, 0, Number.MAX_SAFE_INTEGER);
		limit = bound(limit, 100, 200);
		const directory = await this.target(root, path);
		const entries = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => permitted(entry.name) && !entry.isSymbolicLink())
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		const selected = entries.slice(offset, offset + limit).map((entry) => ({
			name: entry.name,
			type: entry.isDirectory()
				? "directory"
				: entry.isFile()
					? "file"
					: "unsupported",
		}));
		await this.record("list", root, path);
		return {
			identity: this.manifest.identity,
			entries: selected,
			next:
				offset + selected.length < entries.length
					? offset + selected.length
					: null,
			total: entries.length,
		};
	}
	async read(root: Root, path: string, offset = 0, limit = 32768) {
		offset = bound(offset, 0, Number.MAX_SAFE_INTEGER);
		limit = bound(limit, 32768, 65536);
		const target = await this.target(root, path),
			file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await file.stat();
			if (!info.isFile()) throw Error("Not a workspace file");
			const buffer = Buffer.alloc(
				Math.min(limit, Math.max(0, info.size - offset)),
			);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
			if (buffer.subarray(0, bytesRead).includes(0))
				throw Error("Binary workspace file");
			await this.record("read", root, path, bytesRead);
			return {
				identity: this.manifest.identity,
				path,
				offset,
				bytes: bytesRead,
				size: info.size,
				text: buffer.subarray(0, bytesRead).toString("utf8"),
				next: offset + bytesRead < info.size ? offset + bytesRead : null,
			};
		} finally {
			await file.close();
		}
	}
	async search(
		root: Root,
		query: string,
		path = "",
		offset = 0,
		limit = 50,
		lineOffset = 0,
	) {
		if (typeof query !== "string" || !query.length || query.length > 2000)
			throw Error("Invalid workspace query");
		offset = bound(offset, 0, Number.MAX_SAFE_INTEGER);
		limit = bound(limit, 50, 100);
		lineOffset = bound(lineOffset, 0, Number.MAX_SAFE_INTEGER);
		const base = await this.target(root, path),
			files: string[] = [];
		const walk = async (directory: string, prefix: string): Promise<void> => {
			const entries = (await readdir(directory, { withFileTypes: true })).sort(
				(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			);
			for (const entry of entries) {
				const name = prefix ? prefix + "/" + entry.name : entry.name;
				if (!permitted(name) || entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) await walk(join(directory, entry.name), name);
				else if (entry.isFile()) files.push(name);
			}
		};
		await walk(base, path);
		const matches: { path: string; line: number; excerpt: string }[] = [];
		let scanned = 0,
			skippedLarge = 0,
			index = offset,
			nextLine = 0;
		for (
			;
			index < files.length && scanned < 500 && matches.length < limit;
			index++
		) {
			const name = files[index]!;
			scanned++;
			const target = await this.target(root, name),
				info = await stat(target);
			if (info.size > 1048576) {
				skippedLarge++;
				continue;
			}
			const file = await open(
				target,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			let bytes: Buffer;
			try {
				bytes = await file.readFile();
			} finally {
				await file.close();
			}
			if (bytes.includes(0)) continue;
			const text = bytes.toString("utf8");
			await this.record("search-scan", root, name, bytes.length);
			const lines = text.split("\n");
			let line = index === offset ? lineOffset : 0;
			for (; line < lines.length && matches.length < limit; line++)
				if (lines[line]!.includes(query))
					matches.push({
						path: name,
						line: line + 1,
						excerpt: lines[line]!.slice(0, 300),
					});
			if (matches.length === limit && line < lines.length) {
				nextLine = line;
				break;
			}
		}
		await this.record("search", root, path);
		return {
			identity: this.manifest.identity,
			queryDigest: createHash("sha256").update(query).digest("hex"),
			matches,
			next: index < files.length ? index : null,
			nextLine,
			scanned,
			skippedLarge,
		};
	}
}
