import { atomicJson, readJson } from "./storage.js";
import type { TaskApproval } from "./task-approval.js";
import { execFile } from "node:child_process";
import {
	mkdir,
	readFile,
	writeFile,
	rename,
	rm,
	stat,
	mkdtemp,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function trackedFiles(cwd: string) {
	return (
		await run("git", ["-c", "core.hooksPath=/dev/null", "ls-files", "-z"], {
			cwd,
			timeout: 30000,
			maxBuffer: 32 * 1024 * 1024,
		})
	).stdout
		.split("\0")
		.filter(Boolean);
}
export async function git(cwd: string, ...args: string[]) {
	return (
		await run(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=JAM-Bot",
				"-c",
				"user.email=jam-bot@localhost",
				...args,
			],
			{ cwd, timeout: 30000, maxBuffer: 2 ** 20 },
		)
	).stdout.trimEnd();
}

export type ReviewPhase = "architecture" | "implementation" | "diagnosis";
export interface ConsultationProgress {
	phase: ReviewPhase;
	updatedAt: string;
	providers: {
		name: string;
		provider: string;
		model?: string;
		reason?: string;
		status: string;
		startedAt: string;
		updatedAt: string;
		finishedAt?: string;
	}[];
}
export interface Advice {
	name: string;
	provider: string;
	model?: string;
	effort?: string;
	startedAt?: string;
	finishedAt?: string;
	status: "ok" | "unavailable" | "error";
	text: string;
}
interface Request {
	workspace?: { index: string; documents: Record<string, string> };
	repoId?: number;
	issue?: number;
	scope?: string;
	action:
		| "project-profile"
		| "publication-status"
		| "seed"
		| "test-red"
		| "test-head"
		| "test"
		| "publish"
		| "consult";
	phase?: ReviewPhase;
	packet?: string;
	only?: string[];
	repo: string;
	sha?: string;
	base?: string;
	expected?: string;
	cards?: { issue: number; approval: TaskApproval; recipeIdentity?: string }[];
}
export interface WorkspaceInspection {
	revision: string;
	specifications: string;
	readers: {
		reader: string;
		adviser: { name: string; provider: string; model?: string };
		identity: { revision: string; specifications: string };
		observed: number;
		events: { operation: string; root: string; path: string; bytes: number }[];
	}[];
}
export function workspaceInspectionEvent(event: Record<string, unknown>) {
	const { operation, root, path, bytes } = event;
	if (
		typeof operation !== "string" ||
		![
			"read",
			"search",
			"search-scan",
			"list",
			"tools-list",
			"rejected-call",
		].includes(operation) ||
		(root !== "repository" && root !== "specifications") ||
		typeof path !== "string" ||
		path.length > 1024 ||
		path.startsWith("/") ||
		path.split("/").includes("..") ||
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0
	)
		throw Error("Invalid workspace inspection event");
	if (
		(operation === "tools-list" || operation === "rejected-call") &&
		(root !== "repository" || path !== "" || bytes !== 0)
	)
		throw Error("Invalid workspace inspection control event");
	return { operation, root, path, bytes };
}
export function requireWorkspaceInspection(
	inspection: WorkspaceInspection | undefined,
	revision: string,
	specifications: string,
	advice: Advice[],
) {
	if (
		!inspection ||
		inspection.revision !== revision ||
		inspection.specifications !== specifications ||
		!Array.isArray(inspection.readers) ||
		inspection.readers.length > 24
	)
		throw Error("Missing pinned workspace inspection evidence");
	for (const reader of inspection.readers) {
		if (
			reader.identity?.revision !== revision ||
			reader.identity?.specifications !== specifications ||
			!Array.isArray(reader.events) ||
			!advice.some(
				(a) =>
					a.name === reader.adviser?.name &&
					a.provider === reader.adviser?.provider &&
					a.model === reader.adviser?.model,
			)
		)
			throw Error(
				"Workspace inspection belongs to another adviser or snapshot",
			);
	}
	for (const adviser of advice.filter((a) => a.status === "ok")) {
		const verified = inspection.readers.some(
			(reader) =>
				reader.adviser.name === adviser.name &&
				reader.adviser.provider === adviser.provider &&
				reader.adviser.model === adviser.model &&
				reader.events.some(
					(event) =>
						event.operation === "read" &&
						event.root === "repository" &&
						event.bytes > 0 &&
						/\.(?:[cm]?[jt]sx?|html?|css)$/i.test(event.path),
				) &&
				reader.events.some(
					(event) =>
						event.operation === "read" &&
						event.root === "specifications" &&
						event.path === "index.json" &&
						event.bytes > 0,
				),
		);
		if (!verified)
			throw Error(
				"Adviser returned success without pinned code and specification reads",
			);
	}
}
export interface BrokerResult {
	sha: string;
	markdown?: string;
	owner?: string;
	developmentRecipe?: unknown;
	advice?: Advice[];
	inspection?: WorkspaceInspection;
	dev?: string;
	tests?: string[];
	log?: string;
	alreadyPublished?: boolean;
	awaitDeployment?: boolean;
}
export class PublisherSeedUnavailable extends Error {}
export class ProfileLookupUnavailable extends Error {}

interface Reply {
	uncertain?: boolean;
	ok: boolean;
	error?: string;
	value?: BrokerResult;
}
export interface ConsultationSubmission {
	id: string;
	digest: string;
	submittedAt: number;
}
export async function consultationReady(
	state: string,
	submission: ConsultationSubmission,
) {
	if (
		!/^[a-f0-9-]{36}$/.test(submission.id) ||
		!/^[a-f0-9]{64}$/.test(submission.digest) ||
		!Number.isSafeInteger(submission.submittedAt)
	)
		throw Error("Invalid saved consultation request");
	const root =
		process.env.JAM_PROFILE_EXCHANGE ?? "/var/lib/jam-profile-exchange";
	return (
		(await present(join(root, submission.id, "answer.json"))) ||
		(await present(
			join(state, "broker-requests", submission.digest, "reply.json"),
		)) ||
		Date.now() >= submission.submittedAt + 90_000
	);
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const present = async (path: string) =>
	stat(path).then(
		() => true,
		(e) => {
			if (!missing(e)) throw e;
			return false;
		},
	);

function canonical(key: string, value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(
			Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		);
	}
	return value;
}

async function promote(source: string, destination: string) {
	try {
		await rename(source, destination);
	} catch (e) {
		if (
			!["EEXIST", "ENOTEMPTY"].includes(
				(e as NodeJS.ErrnoException).code ?? "",
			) ||
			!(await present(destination))
		)
			throw e;
	}
}

export async function exchange(
	repository: string,
	request: Request,
	signal: AbortSignal,
	onSlow?: (progress: ConsultationProgress) => Promise<void>,
	onProgress?: (progress: ConsultationProgress) => Promise<void>,
	onSubmitted?: (submission: ConsultationSubmission, ready: boolean) => void,
) {
	signal.throwIfAborted();
	const root =
		process.env.JAM_PROFILE_EXCHANGE ?? "/var/lib/jam-profile-exchange";
	// Unscoped seeds deliberately read current remote state during integration reconciliation.
	const durable =
		!["project-profile", "publication-status"].includes(request.action) &&
		(request.action !== "seed" || Boolean(request.scope));
	const digest = createHash("sha256")
		.update(JSON.stringify(request, canonical))
		.digest("hex");
	const id = durable
		? [
				digest.slice(0, 8),
				digest.slice(8, 12),
				digest.slice(12, 16),
				digest.slice(16, 20),
				digest.slice(20, 32),
			].join("-")
		: randomUUID();
	const dir = join(root, id),
		stage = join(root, ".prepared-" + id);
	const ledger = join(dirname(repository), "broker-requests", digest);
	const receipt = join(ledger, "reply.json"),
		intent = join(ledger, "submitted.json");
	if (
		onSubmitted &&
		(request.action !== "consult" ||
			request.phase !== "implementation" ||
			!request.sha ||
			request.only)
	)
		throw Error(
			"Only initial verified implementation advice can yield the native lane",
		);
	const submission = async () => {
		const saved = await readJson<ConsultationSubmission>(intent);
		if (saved.id !== id || saved.digest !== digest)
			throw Error("Saved consultation differs from the exact request");
		return {
			id,
			digest,
			submittedAt:
				saved.submittedAt ?? Math.trunc((await stat(intent)).mtimeMs),
		};
	};
	const value = (reply: Reply) => {
		if (
			!reply.ok &&
			request.action === "seed" &&
			reply.error === "Repository outside publisher scope"
		)
			throw new PublisherSeedUnavailable(
				"Publisher is not configured for this repository",
			);
		if (!reply.ok) throw Error("Profile broker: " + reply.error);
		if (!reply.value) throw Error("Missing profile broker reply");
		if (request.action === "consult" && request.workspace)
			requireWorkspaceInspection(
				reply.value.inspection,
				request.sha!,
				createHash("sha256").update(request.workspace.index).digest("hex"),
				reply.value.advice ?? [],
			);
		return reply.value;
	};
	const cached = async () =>
		durable
			? readJson<Reply>(receipt).catch((e) => {
					if (!missing(e)) throw e;
					return undefined;
				})
			: undefined;
	const previous = await cached();
	if (previous) {
		if (onSubmitted) onSubmitted(await submission(), true);
		return value(previous);
	}
	if (!(await present(dir))) {
		if (!(await present(stage))) {
			if (durable && (await present(intent))) {
				const done = await cached();
				if (done) return value(done);
				throw Error(
					"Missing submitted profile broker request " +
						id +
						" requires reconciliation",
				);
			}
			const temp = await mkdtemp(join(root, ".preparing-"));
			try {
				if (request.sha) {
					const tmp = join(temp, "export");
					await git(temp, "init", "--bare", "export");
					await git(tmp, "fetch", "--no-tags", repository, request.sha);
					await git(tmp, "update-ref", "refs/heads/export", request.sha);
					await git(
						tmp,
						"bundle",
						"create",
						join(temp, "candidate.bundle"),
						"refs/heads/export",
					);
					await rm(tmp, { recursive: true });
				}
				await writeFile(
					join(temp, "request.ready"),
					JSON.stringify({ ...request, brokerRequestId: id }),
					{ mode: 0o600 },
				);
				await promote(temp, stage);
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		}
		if (durable && !(await present(intent)))
			await atomicJson(intent, {
				id,
				digest,
				action: request.action,
				submittedAt: Date.now(),
			});
		try {
			await promote(stage, dir);
		} catch (e) {
			if (!missing(e) || !(await present(dir))) throw e;
		}
	}
	const observed = onSubmitted ? await submission() : undefined;
	if (observed) onSubmitted!(observed, await present(join(dir, "answer.json")));
	let received = false,
		retrySeed = false;
	try {
		const started = observed?.submittedAt ?? Date.now();
		let lastCheck = 0,
			observedSlow = false,
			progressKey = "";
		const until =
			started + (request.action === "consult" ? 35 * 60_000 : 240_000);
		let malformedReads = 0;
		while (Date.now() < until) {
			signal.throwIfAborted();
			const reply = await readFile(join(dir, "answer.json"), "utf8").catch(
				(e: NodeJS.ErrnoException) => {
					if (e.code !== "ENOENT") throw e;
					return "";
				},
			);
			const slow =
				Boolean(onSlow) &&
				!observedSlow &&
				Date.now() - started >= 90000 &&
				Date.now() - lastCheck >= 10000;
			if (onProgress || slow) {
				const current = await readJson<ConsultationProgress>(
					join(dir, "progress.json"),
				).catch((e) => {
					if (!missing(e) && !(e instanceof SyntaxError)) throw e;
				});
				if (
					current &&
					current.phase === request.phase &&
					Array.isArray(current.providers)
				) {
					const key = JSON.stringify(
						current.providers.map((p) => [p.name, p.model, p.status, p.reason]),
					);
					if (onProgress && key !== progressKey) {
						await onProgress(current);
						progressKey = key;
					}
					if (
						slow &&
						!reply &&
						current.providers.some((p) => p.status === "running")
					) {
						lastCheck = Date.now();
						observedSlow = true;
						await onSlow!(current);
					}
				}
			}
			if (!reply) {
				const done = await cached();
				if (done) return value(done);
				await delay(500, undefined, { signal });
				continue;
			}
			let result: Reply;
			try {
				result = JSON.parse(reply) as Reply;
			} catch (error) {
				if (!(error instanceof SyntaxError) || ++malformedReads > 10)
					throw error;
				await delay(500, undefined, { signal });
				continue;
			}
			if (result.uncertain)
				throw Error(
					"Profile broker request " +
						id +
						" requires reconciliation: " +
						(result.error ?? "unknown external result"),
				);
			if (request.action === "consult" && request.workspace && result.value) {
				const file = join(dir, "workspace-reads.jsonl"),
					info = await stat(file);
				if (!info.isFile() || info.size > 2 * 1024 * 1024)
					throw Error("Invalid workspace inspection evidence");
				const raw = await readFile(file, "utf8");
				const expected = {
					revision: request.sha!,
					specifications: createHash("sha256")
						.update(request.workspace.index)
						.digest("hex"),
				};
				const readers = raw
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const row = JSON.parse(line);
						if (
							!/^(codex|antigravity)-[a-f0-9-]{36}$/.test(row.reader) ||
							!Array.isArray(row.events) ||
							row.identity?.revision !== expected.revision ||
							row.identity?.specifications !== expected.specifications ||
							!result.value?.advice?.some(
								(a) =>
									a.name === row.adviser?.name &&
									a.provider === row.adviser?.provider &&
									a.model === row.adviser?.model,
							)
						)
							throw Error("Invalid workspace reader identity");
						if (
							row.events.some(
								(event: {
									identity?: { revision: string; specifications: string };
								}) =>
									event.identity?.revision !== expected.revision ||
									event.identity?.specifications !== expected.specifications,
							)
						)
							throw Error("Workspace event belongs to another snapshot");
						const events = row.events
							.slice(0, 100)
							.map(workspaceInspectionEvent);
						return {
							reader: String(row.reader),
							adviser: {
								name: String(row.adviser.name),
								provider: String(row.adviser.provider),
								...(row.adviser.model
									? { model: String(row.adviser.model) }
									: {}),
							},
							identity: expected,
							observed: row.events.length,
							events,
						};
					});
				if (readers.length > 12) throw Error("Too many workspace readers");
				result.value.inspection = { ...expected, readers };
				requireWorkspaceInspection(
					result.value.inspection,
					expected.revision,
					expected.specifications,
					result.value.advice ?? [],
				);
				await mkdir(ledger, { recursive: true, mode: 0o700 });
				await writeFile(join(ledger, "workspace-reads.jsonl"), raw, {
					mode: 0o600,
				});
			}
			if (result.ok && request.action === "seed") {
				await git(
					repository,
					"fetch",
					"--no-tags",
					join(dir, "seed.bundle"),
					"+refs/heads/seed:refs/remotes/profile/seed",
				);
				// A scoped checkout must remain reachable even if later fresh seeds move the shared ref.
				if (durable && result.value?.sha)
					await git(
						repository,
						"update-ref",
						"refs/jam-bot/seeds/" + digest,
						result.value.sha,
					);
			}
			retrySeed =
				request.action === "seed" &&
				!result.ok &&
				result.error === "Repository outside publisher scope";
			if (durable && !retrySeed) await atomicJson(receipt, result);
			received = true;
			return value(result);
		}
		if (request.action === "project-profile")
			throw new ProfileLookupUnavailable(
				"The read-only profile lookup did not finish",
			);
		throw Error("Profile broker response requires reconciliation");
	} finally {
		if (received) {
			if (durable && retrySeed) await rm(intent, { force: true });
			await rm(dir, { recursive: true, force: true });
			await rm(stage, { recursive: true, force: true });
		}
	}
}

export async function checkout(
	state: string,
	repo: string,
	issue: number,
	signal: AbortSignal,
) {
	const store = join(state, "project.git");
	await mkdir(store, { recursive: true });
	await git(store, "init", "--bare");
	const path = join(state, "assignments", String(issue), "checkout.json");
	let seed = await readJson<BrokerResult>(path).catch(
		(e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		},
	);
	if (!seed) {
		seed = await exchange(
			store,
			{ action: "seed", repo, scope: "issue:" + issue },
			signal,
		);
		await atomicJson(path, seed);
	}
	const branch = "jam/issue-" + issue;
	const tree = join(state, "worktrees", String(issue));
	await mkdir(join(state, "worktrees"), { recursive: true });
	const existing = await git(store, "branch", "--list", branch);
	if (!existing)
		await git(store, "worktree", "add", "-b", branch, tree, seed.sha);
	else if (
		(await git(tree, "branch", "--show-current")) !== branch ||
		(await git(tree, "rev-parse", "HEAD")) !== seed.sha ||
		(await git(tree, "status", "--porcelain"))
	)
		throw Error("Existing worktree conflicts with the recorded task checkout");
	return { store, tree, branch, base: seed.sha, expected: seed.dev ?? "" };
}
