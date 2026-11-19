import { createHash } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceManifest } from "./workspace-reader.js";

export interface WorkspaceBinding {
	session: string;
	member: string;
	challenge: string;
}

export const workspaceDigest = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

export async function bindWorkspace(
	path: string,
	manifest: WorkspaceManifest,
	binding: WorkspaceBinding,
	audit: string,
) {
	const bytes = JSON.stringify({ ...manifest, binding, audit }) + "\n";
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = path + "." + randomUUID();
	try {
		await writeFile(temp, bytes, { flag: "wx", mode: 0o400 });
		await link(temp, path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		if ((await readFile(path, "utf8")) !== bytes)
			throw Error("Native workspace binding differs from its saved dispatch");
	} finally {
		await rm(temp, { force: true });
	}
	return workspaceDigest(bytes);
}

export async function loadWorkspace(
	path: string,
	expected?: { digest: string; binding: WorkspaceBinding },
) {
	const raw = await readFile(path);
	const manifest = JSON.parse(raw.toString("utf8")) as WorkspaceManifest;
	if (manifest.version !== 1) throw Error("Unsupported workspace manifest");
	if (manifest.binding || expected) {
		if (
			!expected ||
			!manifest.binding ||
			workspaceDigest(raw) !== expected.digest ||
			manifest.binding.session !== expected.binding.session ||
			manifest.binding.member !== expected.binding.member ||
			manifest.binding.challenge !== expected.binding.challenge
		)
			throw Error("Native workspace manifest identity mismatch");
	}
	return manifest;
}
