import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const uuid = z.uuid(),
	nameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const topicSchema = z.object({
	repoId: z.number().int().positive(),
	sourceUri: z.string(),
});
const inventorySchema = z.object({
	serverId: uuid,
	topics: z.array(topicSchema),
});
const endpointSchema = z.object({
	name: nameSchema,
	url: z.string(),
	tokenFile: z.string(),
	serverId: uuid,
	topics: z.array(topicSchema),
});
const settingsSchema = z.object({ endpoints: z.array(endpointSchema) });
type Endpoint = z.infer<typeof endpointSchema>;
type Settings = z.infer<typeof settingsSchema>;
function endpointUrl(value: string) {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			))
	)
		throw Error("Expected an HTTPS origin or a loopback HTTP origin");
	return url.origin;
}
async function request(
	endpoint: Pick<Endpoint, "url" | "tokenFile">,
	path: string,
	input?: unknown,
) {
	const bearer = (await readFile(endpoint.tokenFile, "utf8")).trim();
	if (!/^[A-Za-z0-9_~.+/=-]{32,512}$/.test(bearer))
		throw Error("Invalid bearer token file");
	const response = await fetch(endpointUrl(endpoint.url) + path, {
		method: input === undefined ? "GET" : "POST",
		redirect: "error",
		signal: AbortSignal.timeout(60000),
		headers: {
			authorization: "Bearer " + bearer,
			"content-type": "application/json",
		},
		...(input === undefined ? {} : { body: JSON.stringify(input) }),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw Error("Management request failed (HTTP " + response.status + ")");
	}
	const reader = response.body?.getReader();
	if (!reader) throw Error("Management endpoint returned an empty response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > 8 * 1024 * 1024) {
			await reader.cancel();
			throw Error("Management response exceeds 8 MiB");
		}
		chunks.push(value);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const invoke = (
	ep: Pick<Endpoint, "url" | "tokenFile">,
	op: string,
	input: unknown,
) => request(ep, "/api/v1/operations/" + encodeURIComponent(op), input);
async function inventory(
	endpoint: Pick<Endpoint, "url" | "tokenFile">,
	expected?: string,
) {
	const value = inventorySchema.parse(
		await invoke(endpoint, "list_topics", {}),
	);
	if (expected && value.serverId !== expected)
		throw Error("Remote server identity changed; verify the endpoint");
	return value;
}
function guard(input: Record<string, unknown>, key: string, value: unknown) {
	if (input[key] !== undefined && input[key] !== value)
		throw Error("Conflicting target " + key);
	input[key] = value;
}
function sameUri(a: string, b: string) {
	return a.toLowerCase() === b.toLowerCase();
}
export async function cli(
	argv: string[],
	config = process.env.JAM_MANAGEMENT_CONFIG ??
		join(homedir(), ".jam-bot", "management-endpoints.json"),
) {
	let settings: Settings;
	let original: string | undefined;
	try {
		original = await readFile(config, "utf8");
		settings = settingsSchema.parse(JSON.parse(original));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		settings = { endpoints: [] };
	}
	const [cmd, target, operation, arg] = argv;
	const save = async () => {
		await mkdir(dirname(config), { recursive: true, mode: 0o700 });
		const tmp = config + "." + randomUUID();
		// SQLite releases the inter-process lock even if a client exits mid-update.
		const lock = new DatabaseSync(config + ".lock.sqlite");
		try {
			lock.exec("PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
			const current = await readFile(config, "utf8").catch((err) => {
				if (err.code === "ENOENT") return undefined;
				throw err;
			});
			if (current !== original)
				throw Error(
					"Endpoint configuration changed concurrently; retry the command",
				);
			await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", {
				mode: 0o600,
				flag: "wx",
			});
			await rename(tmp, config);
		} finally {
			lock.close();
			await unlink(tmp).catch(() => {});
		}
	};
	const named = (name?: string) => {
		const found = settings.endpoints.find((e) => e.name === name);
		if (!found) throw Error("Unknown endpoint");
		return found;
	};
	if (cmd === "mcp" && target && !operation) {
		const ep = named(target);
		await inventory(ep, ep.serverId);
		const { serveNamedEndpoint } = await import("./management-client-mcp.js");
		await serveNamedEndpoint(endpointUrl(ep.url), ep.tokenFile, ep.serverId);
		return;
	}
	if (cmd === "add" && target && operation && arg) {
		nameSchema.parse(target);
		if (settings.endpoints.some((e) => e.name === target))
			throw Error("Endpoint name already registered");
		const ep = {
			name: target,
			url: endpointUrl(operation),
			tokenFile: resolve(arg),
		};
		const inv = await inventory(ep);
		if (settings.endpoints.some((e) => e.serverId === inv.serverId))
			throw Error("Server already registered");
		settings.endpoints.push({ ...ep, ...inv });
		await save();
		return { name: target, ...inv };
	}
	if (cmd === "inventory") {
		const endpoints = target ? [named(target)] : settings.endpoints;
		const result = await Promise.all(
			endpoints.map(async (ep) => {
				const inv = await inventory(ep, ep.serverId);
				ep.topics = inv.topics;
				return { name: ep.name, ...inv };
			}),
		);
		await save();
		return result;
	}
	if ((cmd !== "route" && cmd !== "call") || !operation || !target)
		throw Error(
			"Use add NAME URL TOKEN_FILE, inventory [NAME], call NAME OPERATION [JSON], or route SOURCE_URI OPERATION [JSON]",
		);
	if (operation === "secret_set" && arg !== "-")
		throw Error(
			"Supply secret_set JSON through stdin using -; values must not be command arguments",
		);
	let json = arg ?? "{}";
	if (arg === "-") {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of process.stdin) {
			const bytes = Buffer.from(chunk);
			size += bytes.length;
			if (size > 262144) throw Error("Operation input is too large");
			chunks.push(bytes);
		}
		json = Buffer.concat(chunks).toString("utf8");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw Error("Invalid operation JSON");
	}
	const input = z.record(z.string(), z.unknown()).parse(parsed);
	let endpoint: Endpoint;
	if (cmd === "route") {
		const cached = settings.endpoints.filter((e) =>
			e.topics.some((t) => sameUri(t.sourceUri, target)),
		);
		const live = await Promise.all(
			settings.endpoints.map(async (ep) => ({
				ep,
				inv: await inventory(ep, ep.serverId),
			})),
		);
		const matches = live.flatMap(({ ep, inv }) =>
			inv.topics
				.filter((t) => sameUri(t.sourceUri, target))
				.map((topic) => ({ ep, topic })),
		);
		if (matches.length !== 1)
			throw Error(
				matches.length
					? "Ambiguous repository; use call with a named endpoint and explicit repoId"
					: "Repository not connected",
			);
		const match = matches[0]!;
		if (
			cached.length !== 1 ||
			cached[0]?.serverId !== match.ep.serverId ||
			!cached[0].topics.some(
				(t) => t.repoId === match.topic.repoId && sameUri(t.sourceUri, target),
			)
		)
			throw Error(
				"Repository placement changed; inspect inventory before retrying",
			);
		endpoint = match.ep;
		guard(input, "repoId", match.topic.repoId);
	} else {
		endpoint = named(target);
		await inventory(endpoint, endpoint.serverId);
	}
	const document = (await request(endpoint, "/api/v1/openapi.json")) as {
		paths: Record<
			string,
			{
				post: {
					"x-mutating": boolean;
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: Record<string, unknown> };
							};
						};
					};
				};
			}
		>;
	};
	const def = document.paths["/api/v1/operations/" + operation]?.post;
	if (typeof def?.["x-mutating"] !== "boolean")
		throw Error("Unknown management operation");
	if (
		def["x-mutating"] ||
		Object.hasOwn(
			def.requestBody.content["application/json"].schema.properties,
			"serverId",
		)
	)
		guard(input, "serverId", endpoint.serverId);
	return invoke(endpoint, operation, input);
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	cli(process.argv.slice(2))
		.then((result) => {
			if (result !== undefined) console.log(JSON.stringify(result, null, 2));
		})
		.catch((err) => {
			console.error(err.message);
			process.exitCode = 1;
		});
