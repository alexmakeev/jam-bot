import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { readdir, lstat, readFile, realpath, statfs } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { IntegrationQueue } from "./integration-queue.js";
import {
	ManagementError,
	requireTopic,
	targetFields,
	type ManagementOperation,
} from "./management-contract.js";
import type { TopicRuntime } from "./topics.js";

const role = z.enum([
	"architect",
	"designer",
	"assignment",
	"developer",
	"consultant",
	"integrator",
	"cleaner",
]);
export function diagnosticText(text: string) {
	return text
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
			"[private key redacted]",
		)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g,
			"[credential redacted]",
		)
		.replace(/\b(Bearer\s+)[A-Za-z0-9_~.+/=-]+/gi, "$1[redacted]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi,
			"$1[redacted]",
		);
}
async function jsonFile(root: string, path: string, maximum = 1024 * 1024) {
	const file = join(root, path),
		resolved = await realpath(file),
		part = relative(await realpath(root), resolved);
	if (part.startsWith("..") || isAbsolute(part))
		throw Error("Diagnostic file escapes registered directory");
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
		throw Error("Unsupported diagnostic record");
	return {
		value: JSON.parse(await readFile(file, "utf8")),
		modifiedAt: info.mtimeMs,
	};
}
function metadata(value: unknown) {
	return typeof value === "string"
		? diagnosticText(value).slice(0, 180)
		: typeof value === "number" && Number.isFinite(value)
			? value
			: null;
}
function inspectionEvent(event: Record<string, unknown>) {
	return {
		operation: metadata(event.operation),
		root: metadata(event.root),
		path: metadata(event.path),
		bytes: metadata(event.bytes),
	};
}
function boundResponse(
	result: Record<string, any>,
	maximum: number,
	offset: number,
) {
	const size = () => Buffer.byteLength(JSON.stringify(result));
	if (size() <= maximum) return result;
	result.limitations = [
		"Response size limited; follow next or increase maxBytes.",
	];
	const rows = Array.isArray(result.data)
		? result.data
		: Array.isArray(result.data?.work)
			? result.data.work
			: undefined;
	if (rows) {
		while (rows.length && size() > maximum) {
			rows.pop();
			result.next = offset + rows.length;
		}
	} else if (typeof result.data?.text === "string") {
		const bytes = Buffer.from(result.data.text);
		let length = bytes.length;
		while (length > 0 && size() > maximum) {
			length = Math.max(0, length - 128);
			result.data.text = bytes
				.subarray(0, length)
				.toString("utf8")
				.replace(/\uFFFD$/, "");
			result.next = offset + Buffer.byteLength(result.data.text);
		}
	}
	if (size() > maximum || result.next === offset)
		throw new ManagementError(
			413,
			"diagnostic_budget_too_small",
			"Increase maxBytes to fit one diagnostic record.",
		);
	return result;
}
function progressDb(state: string) {
	const file = join(state, "work-progress.sqlite");
	if (!existsSync(file)) return;
	const db = new DatabaseSync(file, { readOnly: true });
	db.exec("PRAGMA busy_timeout=3000");
	return db;
}
export async function diskStatus(path: string) {
	const s = await statfs(path, { bigint: true });
	const totalBytes = s.blocks * s.bsize,
		freeBytes = s.bavail * s.bsize;
	const usedPercent = totalBytes
		? Number(((totalBytes - freeBytes) * 10000n) / totalBytes) / 100
		: 0;
	return {
		usedPercent,
		freeBytes: freeBytes.toString(),
		totalBytes: totalBytes.toString(),
		status:
			usedPercent >= 95
				? "red"
				: usedPercent >= 85
					? "orange"
					: usedPercent >= 70
						? "yellow"
						: "green",
	};
}
export function diagnosticOperations(
	routes: Map<string, TopicRuntime>,
): ManagementOperation[] {
	const operations: ManagementOperation[] = [
		{
			name: "diagnostics",
			description:
				"Start with a compact repository summary including any recorded human-review queue barrier, then inspect one issue through bounded agent checkpoints, progress events, report indexes or a selected published report. No prompts, private reasoning, credentials, raw terminal transcripts or arbitrary host files are exposed.",
			mutate: false,
			input: z.strictObject({
				...targetFields,
				view: z
					.enum([
						"summary",
						"agents",
						"events",
						"inspection",
						"artifacts",
						"artifact",
					])
					.default("summary"),
				issue: z.int().positive().optional(),
				role: role.optional(),
				offset: z.int().nonnegative().default(0),
				limit: z.int().min(1).max(50).default(10),
				artifactId: z
					.string()
					.regex(/^[a-z]+:[a-f0-9]{64}$/)
					.optional(),
				maxBytes: z.int().min(256).max(16000).default(4000),
			}),
			output: z.strictObject({
				view: z.string(),
				data: z.unknown(),
				next: z.int().nullable(),
				limitations: z.array(z.string()),
			}),
			run: async ({
				repoId,
				view,
				issue,
				role: filter,
				offset,
				limit,
				artifactId,
				maxBytes,
			}) => {
				const route = requireTopic(routes, repoId),
					{ state, journal } = route;
				const limitations = [
					"Local recorded state is not a guarantee that a provider is making progress.",
					"Raw model reasoning, prompts, terminal logs and credentials are excluded.",
				];
				if (view === "summary") {
					const work = journal.db
						.prepare(
							"SELECT issue,title,state,workerState,reason,workerReason FROM intake ORDER BY rowid DESC LIMIT ? OFFSET ?",
						)
						.all(limit, offset);
					const queue = new IntegrationQueue(journal.db).snapshot();
					const reviewWhere = "state='review' OR workerState='review'";
					const blockingIssueCount = Number(
						journal.db
							.prepare(
								"SELECT count(DISTINCT issue) AS count FROM intake WHERE " +
									reviewWhere,
							)
							.get()!.count,
					);
					const blockingIssues = journal.db
						.prepare(
							"SELECT issue,MAX(state='review') AS intakeReview FROM intake WHERE " +
								reviewWhere +
								" GROUP BY issue ORDER BY MIN(rowid) LIMIT 3",
						)
						.all()
						.map((row) => ({
							issue: row.issue,
							phase: row.intakeReview ? "intake" : "worker",
						}));
					const coordination = {
						reviewBarrier: blockingIssueCount > 0,
						blockingIssueCount,
						blockingIssues,
					};
					return {
						view,
						data: {
							repository: route.topic.repository,
							work: work.map((row) => ({
								...row,
								title: diagnosticText(String(row.title)).slice(0, 200),
								reason: row.reason
									? "Operator review required; inspect issue checkpoints."
									: null,
								workerReason:
									row.workerState === "pending" &&
									typeof row.workerReason === "string" &&
									row.workerReason.startsWith("Dependency: ")
										? diagnosticText(row.workerReason).slice(0, 180)
										: row.workerReason
											? "Worker review required; inspect issue checkpoints."
											: null,
							})),
							coordination,
							readyCount: queue.ready.length,
							integrating: queue.active
								? {
										id: queue.active.id,
										issueCount: queue.active.entries.length,
									}
								: null,
							disk: await diskStatus(state),
						},
						next: work.length === limit ? offset + limit : null,
						limitations,
					};
				}
				if (
					!issue ||
					!journal.db
						.prepare("SELECT 1 FROM intake WHERE issue=? AND action='task'")
						.get(issue)
				)
					throw new ManagementError(
						404,
						"diagnostic_issue_missing",
						"Select a registered work card.",
					);
				if (filter && view !== "agents")
					throw new ManagementError(
						400,
						"role_filter_unsupported",
						"Role filtering applies to the agent view.",
					);
				if (view === "inspection") {
					const entries: Record<string, unknown>[] = [];
					const root = join(
						state,
						"assignments",
						String(issue),
						"workspace-access",
					);
					const names = (
						await readdir(root).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return [];
							throw error;
						})
					)
						.filter((name) => /^[a-z]+-[a-f0-9-]{36}\.jsonl$/.test(name))
						.sort()
						.slice(0, 50);
					for (const name of names) {
						const file = join(root, name),
							info = await lstat(file);
						if (
							!info.isFile() ||
							info.isSymbolicLink() ||
							info.size > 262144 ||
							(await realpath(file)) !== file
						) {
							limitations.push(
								"An oversized or redirected native inspection trace was omitted.",
							);
							continue;
						}
						for (const line of (await readFile(file, "utf8"))
							.split("\n")
							.filter(Boolean)
							.slice(0, 2000)) {
							const row = JSON.parse(line);
							entries.push({
								role: name.split("-")[0],
								...inspectionEvent(row),
							});
						}
					}
					for (const phase of ["architecture", "implementation", "diagnosis"]) {
						const root = join(
							state,
							"assignments",
							String(issue),
							"consultations",
						);
						if (!existsSync(join(root, phase + ".json"))) continue;
						const { value } = await jsonFile(root, phase + ".json");
						for (const inspection of value.inspection ?? [])
							for (const reader of inspection.readers ?? [])
								for (const event of reader.events ?? [])
									entries.push({
										phase,
										provider: String(reader.reader).split("-")[0],
										revision: metadata(inspection.revision),
										...inspectionEvent(event),
									});
					}
					return {
						view,
						data: entries.slice(offset, offset + limit),
						next: offset + limit < entries.length ? offset + limit : null,
						limitations,
					};
				}
				if (view === "agents") {
					const root = join(state, "assignments", String(issue), "roles");
					const names = (
						await readdir(root).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return [];
							throw error;
						})
					)
						.filter(
							(name) =>
								/^[a-z]+-[a-f0-9]{64}\.json$/.test(name) &&
								(!filter || name.startsWith(filter + "-")),
						)
						.sort();
					const records = names.map((name) => ({
						root,
						name,
						role: name.split("-")[0],
					}));
					const reviews = join(state, "mandatory-reviews");
					for (const name of await readdir(reviews).catch(
						(error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return [];
							throw error;
						},
					)) {
						const match =
							/^(consultant|integrator)-([0-9-]+)-[a-f0-9]{40}(?:-evidence-[0-9]+)?\.json$/.exec(
								name,
							);
						if (
							match &&
							match[2]!.split("-").map(Number).includes(issue) &&
							(!filter || match[1] === filter)
						)
							records.push({ root: reviews, name, role: match[1] });
					}
					const agents = [];
					for (const record of records) {
						const { value, modifiedAt } = await jsonFile(
							record.root,
							record.name,
						);
						const rawStarted =
							value.startedAt ?? value.attempts?.at(-1)?.startedAt;
						const startedAt =
							typeof rawStarted === "number" && Number.isFinite(rawStarted)
								? rawStarted
								: null;
						const workspace = value.receipt?.workspaceEvidence;
						agents.push({
							role: record.role,
							state: value.failure
								? "blocked"
								: value.receipt
									? "completed"
									: "awaiting receipt",
							failureCategory: [
								"refusal",
								"harness_refusal",
								"missing_result",
								"uncertain_execution",
								"runtime_failure",
							].includes(value.failureCategory)
								? value.failureCategory
								: null,
							startedAt,
							lastRecordedAt: modifiedAt,
							attempt: metadata(value.attempt ?? value.attempts?.length),
							recordedIntervalMs:
								startedAt !== null
									? Math.max(
											0,
											(value.receipt || value.failure
												? modifiedAt
												: Date.now()) - startedAt,
										)
									: null,
							nativeMember: metadata(value.receipt?.nativeMember),
							...(workspace
								? {
										workspace: {
											advertised: workspace.advertised === true,
											memberCalls: Number.isSafeInteger(workspace.memberCalls)
												? workspace.memberCalls
												: null,
											sourceRead: workspace.sourceRead === true,
											specificationIndexRead:
												workspace.specificationIndexRead === true,
										},
									}
								: {}),
						});
					}
					const consultations = [];
					for (const phase of ["architecture", "implementation", "diagnosis"]) {
						const file = join(
							state,
							"assignments",
							String(issue),
							"consultations",
							phase + ".json",
						);
						if (!existsSync(file)) continue;
						const { value } = await jsonFile(
							join(state, "assignments", String(issue), "consultations"),
							phase + ".json",
						);
						for (const advice of (value.advice ?? []).slice(0, 12))
							consultations.push({
								phase,
								provider: metadata(advice.provider),
								model: metadata(advice.model),
								effort: metadata(advice.effort),
								status: metadata(advice.status),
								startedAt: metadata(advice.startedAt),
								finishedAt: metadata(advice.finishedAt),
							});
					}
					const pendingConsultations = [];
					const exchange =
						process.env.JAM_PROFILE_EXCHANGE ?? "/var/lib/jam-profile-exchange";
					const requests = (
						await readdir(exchange).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return [];
							throw error;
						})
					)
						.filter((name) => /^[a-f0-9-]{36}$/.test(name))
						.slice(0, 200);
					for (const request of requests) {
						const record = await jsonFile(
							exchange,
							request + "/request.json",
							3 * 1024 * 1024,
						).catch(() => undefined);
						if (
							record?.value.action !== "consult" ||
							record.value.repo !== route.topic.repository ||
							!record.value.cards?.some(
								(card: { issue: number }) => card.issue === issue,
							)
						)
							continue;
						const progress = await jsonFile(
							exchange,
							request + "/progress.json",
						).catch(() => undefined);
						if (!progress) continue;
						pendingConsultations.push({
							phase: record.value.phase,
							revision: record.value.sha ?? null,
							updatedAt: progress.value.updatedAt,
							providers: (progress.value.providers ?? [])
								.slice(0, 12)
								.map((provider: Record<string, unknown>) => ({
									name: provider.name,
									provider: provider.provider,
									model: provider.model,
									status: provider.status,
									startedAt: provider.startedAt,
									updatedAt: provider.updatedAt,
									lastOutputAt: provider.lastOutputAt,
									finishedAt: provider.finishedAt,
									outputBytes: provider.outputBytes,
								})),
						});
					}
					if (requests.length === 200)
						limitations.push(
							"Pending consultation inspection is capped at 200 registered exchanges.",
						);
					const all = [
						...agents.map((row) => ({ kind: "agent", ...row })),
						...(!filter || filter === "consultant"
							? [
									...consultations.map((row) => ({
										kind: "consultation",
										...row,
									})),
									...pendingConsultations.flatMap((row) =>
										row.providers.map((provider: Record<string, unknown>) => ({
											kind: "pending-consultation",
											phase: metadata(row.phase),
											revision: metadata(row.revision),
											...Object.fromEntries(
												Object.entries(provider).map(([key, value]) => [
													key,
													metadata(value),
												]),
											),
										})),
									),
								]
							: []),
					];
					return {
						view,
						data: all.slice(offset, offset + limit),
						next: offset + limit < all.length ? offset + limit : null,
						limitations,
					};
				}
				const db = progressDb(state);
				if (!db) return { view, data: [], next: null, limitations };
				try {
					if (view === "events") {
						const rows = db
							.prepare(
								"SELECT rowid,key,body,status FROM events WHERE issue=? ORDER BY rowid DESC LIMIT ? OFFSET ?",
							)
							.all(issue, limit, offset);
						return {
							view,
							data: rows.map((row) => ({
								...row,
								body: diagnosticText(String(row.body)).slice(0, 1000),
							})),
							next: rows.length === limit ? offset + limit : null,
							limitations,
						};
					}
					if (view === "artifacts") {
						const rows = db
							.prepare(
								`SELECT DISTINCT r.purpose,r.digest,length(r.markdown) AS characters FROM event_reports r JOIN events e ON e.issue=r.issue AND e.key=r.key WHERE r.issue=? AND e.status='sent' AND e.receipt>0 AND r.purpose IN ('review','tests','consultation','plan','assignment','design','integration','cleanup') ORDER BY r.purpose,r.digest LIMIT ? OFFSET ?`,
							)
							.all(issue, limit, offset);
						return {
							view,
							data: rows.map((row) => ({
								id: row.purpose + ":" + row.digest,
								purpose: row.purpose,
								characters: row.characters,
							})),
							next: rows.length === limit ? offset + limit : null,
							limitations,
						};
					}
					if (!artifactId)
						throw new ManagementError(
							400,
							"artifact_required",
							"Select an artifact from the report index.",
						);
					const [purpose, digest] = artifactId.split(":");
					const row = db
						.prepare(
							`SELECT r.markdown FROM event_reports r JOIN events e ON e.issue=r.issue AND e.key=r.key WHERE r.issue=? AND r.purpose=? AND r.digest=? AND e.status='sent' AND e.receipt>0 AND r.purpose IN ('review','tests','consultation','plan','assignment','design','integration','cleanup') LIMIT 1`,
						)
						.get(issue, purpose!, digest!);
					if (!row)
						throw new ManagementError(
							404,
							"artifact_missing",
							"The selected report does not belong to this work card.",
						);
					const safe = Buffer.from(diagnosticText(String(row.markdown)));
					return {
						view,
						data: {
							artifactId,
							text: safe.subarray(offset, offset + maxBytes).toString("utf8"),
							totalBytes: safe.length,
						},
						next: offset + maxBytes < safe.length ? offset + maxBytes : null,
						limitations,
					};
				} finally {
					db.close();
				}
			},
		},
	];
	return operations.map((operation) => ({
		...operation,
		run: async (input) =>
			boundResponse(await operation.run(input), input.maxBytes, input.offset),
	}));
}
