import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
	signEnvironment,
	validEnvironmentSignature,
	type EnvironmentAction,
	type EnvironmentResult,
} from "./environment-wire.js";

const authority = new AsyncLocalStorage<string>();
export function withEnvironmentAuthority<T>(
	bearer: string,
	action: () => T,
): T {
	return authority.run(bearer, action);
}
export function withoutEnvironmentAuthority<T>(action: () => T): T {
	return authority.exit(action);
}
export async function runEnvironment(
	input: EnvironmentAction,
	signal?: AbortSignal,
): Promise<EnvironmentResult> {
	return ownerHostRequest<EnvironmentResult>(input, signal);
}

/** Only the active authenticated management request can sign calls to the private host. */
export async function ownerHostRequest<T>(
	input: object,
	signal?: AbortSignal,
): Promise<T> {
	const token = authority.getStore();
	if (!token)
		throw Error(
			"Environment changes require an authenticated management request",
		);
	const root = process.env.JAM_DEPLOY_EXCHANGE;
	if (!root) throw Error("Host environment runner is not configured");
	const id = randomUUID(),
		body = JSON.stringify({ id, at: Date.now(), ...input });
	const path = join(root, id),
		response = path + ".response";
	await writeFile(
		path + ".tmp",
		JSON.stringify({
			body,
			signature: signEnvironment(token, "request", body),
		}),
		{ mode: 0o600, flag: "wx" },
	);
	await rename(path + ".tmp", path + ".request");
	const until = Date.now() + 170000;
	while (Date.now() < until) {
		signal?.throwIfAborted();
		const raw = await readFile(response, "utf8").catch(
			(e: NodeJS.ErrnoException) => {
				if (e.code !== "ENOENT") throw e;
				return "";
			},
		);
		if (raw) {
			if (raw.length > 8192) throw Error("Invalid host response size");
			const msg = JSON.parse(raw);
			if (
				typeof msg.body !== "string" ||
				!validEnvironmentSignature(token, "response", msg.body, msg.signature)
			)
				throw Error("Host response signature invalid");
			const reply = JSON.parse(msg.body);
			if (reply.id !== id) throw Error("Mismatched host response");
			await rm(response);
			if (!reply.ok) throw Error(String(reply.error));
			return reply.value;
		}
		await delay(200, undefined, { signal });
	}
	throw Error(
		"Environment action is still unconfirmed; inspect runtime status",
	);
}

export interface SecretOperation {
	serverId: string;
	repoId: number;
	environment: string;
	alias?: string;
	action: "secret-set" | "secret-get";
	requestId?: string;
}

/** Secret bytes stay in a protected temporary blob, never in the durable command envelope. */
export async function runSecretOperation(
	input: SecretOperation,
	value?: string,
): Promise<Record<string, unknown>> {
	const token = authority.getStore();
	const root = process.env.JAM_DEPLOY_EXCHANGE;
	if (!token || !root)
		throw Error("Secret operations require authenticated host management");
	if (input.action === "secret-get") return ownerHostRequest(input);
	if (
		typeof value !== "string" ||
		!value.length ||
		Buffer.byteLength(value) > 65536
	)
		throw Error("Invalid secret value");
	const blobId = randomUUID();
	const folder = join(await realpath(root), "secret-blobs");
	await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const info = await lstat(folder);
	if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
		throw Error("Invalid protected secret staging directory");
	const file = await open(join(folder, blobId), "wx", 0o600);
	try {
		await file.writeFile(value, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	const directory = await open(folder, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
	const digest = signEnvironment(
		token,
		"request",
		"jam-secret-blob-v1\0" + value,
	);
	// A timed-out command may still run on the host. Only the host removes its blob after a durable result.
	return ownerHostRequest({ ...input, blobId, blobDigest: digest });
}
