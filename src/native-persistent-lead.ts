import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { nativeLeadBusyCode, startNativeLead } from "./native-lead.js";
import {
	nativeWorkerAuthority,
	nativeWorkerOwnsParkedStage,
	type NativeWorkerIntent,
} from "./native-worker-wait.js";
import {
	mailboxReceipt,
	nativeDispatchRefused,
	nativeFollowupReceipt,
	nativeMailboxBody,
	nativeSharedWorkspaceEvidence,
	nativeWorkspaceTurn,
	stageRefused,
} from "./native-teammate.js";
import { SharedWorkspace } from "./shared-workspace.js";
import {
	nativeRoleInput,
	nativeRoleInstructions,
	type RoleStage,
} from "./role-harness.js";
import { fingerprint } from "./work-progress.js";
import {
	bindWorkspace,
	loadWorkspace,
	workspaceDigest,
} from "./workspace-binding.js";
import { atomicJson, claimJson, readJson } from "./storage.js";

type Bootstrap = Parameters<typeof mailboxReceipt>[0];
interface Request {
	name: string;
	challenge: string;
	issue: number;
	input: string;
	workspaceManifest?: string;
}
interface AuthorizedRequest extends Request {
	authority: NativeWorkerIntent;
	agentType: string;
	beforeSend: () => Promise<void>;
}
interface Intent {
	version: 1 | 2 | 3;
	issue: number;
	initial: Bootstrap;
	handle: string;
	prompt: string;
	request: string;
	challenge: string;
	workspacePin?: string;
	authority?: string;
}
interface LeadOptions {
	state: string;
	cwd: string;
	model: string;
	effort?: "low" | "medium" | "high";
	signal: AbortSignal;
}
interface NativeTurn {
	type: string;
	sessionId?: string;
	agentId?: string;
	isApiErrorMessage?: boolean;
	error?: string;
	isMeta?: boolean;
	promptId?: string;
	message?: { content?: unknown; stop_reason?: string };
}
interface DispatchAcknowledgement {
	session: string;
	member: string;
	handle: string;
	challenge: string;
	promptId: string;
}

export function reportsNativeAuthenticationFailure(
	rows: NativeTurn[],
	session: string,
) {
	return rows.some(
		(row) =>
			row.type === "assistant" &&
			row.sessionId === session &&
			!row.agentId &&
			row.isApiErrorMessage === true &&
			row.error === "authentication_failed",
	);
}
const actorType = "jam-persistent-workspace-member";
const managerType = "jam-persistent-card-manager";
const architectType = "jam-persistent-architect-integrator";
const consultantType = "jam-persistent-independent-consultant";

export function persistentNativeActor(
	role: NativeWorkerIntent["role"],
	issue: number,
) {
	if (role === "assignment" || role === "developer")
		return { name: "manager-" + issue, agentType: managerType };
	if (role === "consultant")
		return { name: "consultant-" + issue, agentType: consultantType };
	return { name: "architect-integration", agentType: architectType };
}

const workspaceTools = [
	"workspace_list",
	"workspace_read",
	"workspace_search",
] as const;
const invocation = (...args: string[]) =>
	args.map((value) => "'" + value.replaceAll("'", "'\\''") + "'").join(" ");
const intents = (state: string, challenge: string) =>
	join(state, "native-persistent-dispatches", challenge + ".json");
const safeInput = /^[\w-]{1,128}$/;
const optionalText = (path: string) =>
	readFile(path, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return "";
	});
const transcriptPath = (config: string, cwd: string, session: string) =>
	join(
		config,
		"projects",
		cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
		session + ".jsonl",
	);

async function confirmsCatalog(directory: string, session: string) {
	const receipt = await readJson<{ session: string; tools: string[] }>(
		join(directory, "workspace-catalog.json"),
	).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	return (
		receipt?.session === session &&
		Array.isArray(receipt.tools) &&
		receipt.tools.length === workspaceTools.length &&
		workspaceTools.every((name) => receipt.tools.includes(name))
	);
}

async function sharedWorkspaceEvidence(
	directory: string,
	intent: Intent,
	workspace: SharedWorkspace,
) {
	if (!intent.workspacePin) return;
	const { session, name: member } = intent.initial;
	const { challenge, handle } = intent;
	const manifest = await loadWorkspace(
		join(directory, "manifests", challenge + ".json"),
		{ digest: intent.workspacePin, binding: { session, member, challenge } },
	);
	if (manifest.audit !== join(directory, "reads", challenge + ".jsonl"))
		throw Error("Native workspace audit differs from its original admission");
	return nativeSharedWorkspaceEvidence(
		intent.initial,
		handle,
		manifest,
		workspace.usedCalls(challenge, session, handle),
		await confirmsCatalog(directory, session),
	);
}

export async function recoverPersistentDispatch(
	state: string,
	issue: number,
	challenge: string,
	expected?: NativeWorkerIntent,
) {
	if (!safeInput.test(challenge))
		throw Error("Invalid persistent dispatch identity");
	const original = await readJson<Intent>(intents(state, challenge)).catch(
		(error) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		},
	);
	if (!original) return;
	if (
		![1, 2, 3].includes(original.version) ||
		original.issue !== issue ||
		original.challenge !== challenge ||
		(original.version === 3 &&
			(!expected || original.authority !== nativeWorkerAuthority(expected))) ||
		(expected &&
			(original.version !== 3 ||
				expected.issue !== issue ||
				expected.challenge !== challenge))
	)
		throw Error("Persistent dispatch differs from its approved checkpoint");
	if (
		typeof original.initial?.session !== "string" ||
		typeof original.initial.name !== "string" ||
		!safeInput.test(original.initial.session) ||
		!safeInput.test(original.initial.name)
	)
		throw Error("Invalid saved native generation");
	if (expected) {
		const actor = persistentNativeActor(expected.role, expected.issue);
		if (
			original.initial.name !== actor.name ||
			original.initial.agentType !== actor.agentType
		)
			throw Error("Native dispatch member differs from its approved role");
	}
	const result = await nativeFollowupReceipt({
		...original,
		allowOtherMembers: true,
		allowLaterDelivery: original.version >= 2,
	});
	if (!result) return { attempted: true as const };
	const directory = join(
		state,
		"shared-native-leads",
		original.initial.session,
	);
	let workspaceEvidence: Awaited<ReturnType<typeof sharedWorkspaceEvidence>>;
	if (original.workspacePin) {
		const workspace = new SharedWorkspace(join(directory, "workspace.sqlite"));
		try {
			workspaceEvidence = await sharedWorkspaceEvidence(
				directory,
				original,
				workspace,
			);
		} finally {
			workspace.close();
		}
	}
	return {
		attempted: true as const,
		receipt: {
			developer: result.handle,
			nativeMember: result.nativeMember,
			backend: "in-process" as const,
			team: "session-" + original.initial.session.slice(0, 8),
			output: result.output,
			...(workspaceEvidence ? { workspaceEvidence } : {}),
		},
	};
}

export class PersistentNativeLead {
	private constructor(
		private readonly options: LeadOptions,
		readonly session: string,
		private readonly config: string,
		private readonly directory: string,
		private readonly terminal: string,
		private readonly child: Awaited<ReturnType<typeof startNativeLead>>,
		private readonly workspace: SharedWorkspace,
	) {
		child.on("error", () => {
			this.unavailable = true;
		});
		child.stdin.on("error", () => {
			this.unavailable = true;
		});
		this.closed = new Promise((resolve) =>
			child.once("close", () => resolve()),
		);
	}
	private readonly closed: Promise<void>;
	private readonly startedAt = Date.now();
	private readonly actors = new Map<
		string,
		{ initial: Bootstrap; handle: string }
	>();
	private writes = Promise.resolve();
	private readonly activeMembers = new Set<string>();
	private readonly completions = new Set<Promise<unknown>>();
	private unavailable = false;

	static async start(options: LeadOptions) {
		const session = randomUUID();
		const config = await realpath(
			process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
		);
		const directory = join(options.state, "shared-native-leads", session);
		const home = join(directory, "home"),
			terminal = join(directory, "terminal.log"),
			database = join(directory, "workspace.sqlite");
		const catalog = join(directory, "workspace-catalog.json");
		await mkdir(home, { recursive: true, mode: 0o700 });
		await symlink(config, join(home, ".claude"));
		await writeFile(
			join(home, ".claude.json"),
			JSON.stringify({
				hasCompletedOnboarding: true,
				numStartups: 2,
				projects: { [options.cwd]: { hasTrustDialogAccepted: true } },
			}),
			{ mode: 0o600 },
		);
		await claimJson(join(directory, "generation.json"), {
			version: 1,
			session,
			cwd: options.cwd,
		});
		const workspace = new SharedWorkspace(database, true);
		try {
			const capabilities = workspaceTools.map(
				(name) => "mcp__jam_workspace__" + name,
			);
			const hook = new URL("./shared-workspace-hook.js", import.meta.url)
				.pathname;
			const server = new URL("./workspace-mcp.js", import.meta.url).pathname;
			const settings = {
				switchModelsOnFlag: false,
				hooks: {
					PreToolUse: [
						{
							matcher: "mcp__jam_workspace__.*",
							hooks: [
								{
									type: "command",
									command: invocation(process.execPath, hook, database),
									timeout: 10,
									onFailure: "block",
								},
							],
						},
					],
				},
			};
			const agents = Object.fromEntries(
				[
					[actorType, "Named fixture member"],
					[managerType, "Persistent manager of one approved work card"],
					[architectType, "Shared architect and integrator for this topic"],
					[consultantType, "Independent reviewer of one approved work card"],
				].map(([type, description]) => [
					type,
					{
						description: "JAM-Bot " + description,
						tools: ["SendMessage", ...capabilities],
						prompt:
							description +
							". Bootstrap by sending the supplied token exactly, without tools other than SendMessage. On a later assigned dispatch, follow the approved instructions and send the exact nonce on its own line followed by the work product. Only inspect the currently admitted workspace. Return one Blocked: line when runtime access prevents valid work.",
					},
				]),
			);
			const args = [
				"--session-id",
				session,
				"--model",
				options.model,
				...(options.effort ? ["--effort", options.effort] : []),
				"--setting-sources",
				"",
				"--settings",
				JSON.stringify(settings),
				"--teammate-mode",
				"in-process",
				"--strict-mcp-config",
				"--mcp-config",
				JSON.stringify({
					mcpServers: {
						jam_workspace: {
							alwaysLoad: true,
							command: process.execPath,
							args: [server, "--shared", database, session, catalog],
						},
					},
				}),
				"--tools",
				"Agent,SendMessage",
				"--allowedTools",
				["Agent", "SendMessage", ...capabilities].join(","),
				"--agents",
				JSON.stringify(agents),
				"--permission-mode",
				"dontAsk",
				"--disable-slash-commands",
				"--system-prompt",
				"You coordinate one native team. Only spawn the requested named members and forward exact requests. End the lead turn after the requested receipt. Do not run workspace tools yourself.",
				"Return READY without spawning anyone.",
			];
			const child = await startNativeLead(
				options.state,
				["-qefc", "exec " + invocation("claude", ...args), terminal],
				{
					cwd: options.cwd,
					env: {
						...process.env,
						HOME: home,
						TERM: "xterm-256color",
						CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
					},
				},
			);
			const lead = new PersistentNativeLead(
				options,
				session,
				config,
				directory,
				terminal,
				child,
				workspace,
			);
			try {
				await lead.wait(async () => {
					if (!(await lead.endedAfter(0))) return;
					return confirmsCatalog(directory, session);
				}, 30000);
			} catch (error) {
				await lead.close();
				throw error;
			}
			return lead;
		} catch (error) {
			try {
				workspace.close();
			} catch {}
			throw error;
		}
	}

	private async transcript(): Promise<NativeTurn[]> {
		const body = await optionalText(
			transcriptPath(this.config, this.options.cwd, this.session),
		);
		if (Buffer.byteLength(body) > 64 * 1024 * 1024)
			throw Error("Native lead transcript requires rotation");
		return body
			.slice(0, body.lastIndexOf("\n") + 1)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}
	private async endedAfter(index: number) {
		return (await this.transcript())
			.slice(index)
			.some(
				(row) =>
					row.type === "assistant" && row.message?.stop_reason === "end_turn",
			);
	}
	private async endedAfterDelivery(
		index: number,
		name: string,
		challenge: string,
	) {
		const rows = (await this.transcript()).slice(index);
		const delivered = rows.findIndex((row) => {
			if (row.type !== "user" || typeof row.message?.content !== "string")
				return false;
			const body = nativeMailboxBody(row.message.content, name);
			return body === challenge || body?.startsWith(challenge + "\n");
		});
		return (
			delivered >= 0 &&
			rows
				.slice(delivered + 1)
				.some(
					(row) =>
						row.type === "assistant" && row.message?.stop_reason === "end_turn",
				)
		);
	}
	private async wait<T>(
		check: () => Promise<T | false | undefined>,
		milliseconds = 15 * 60_000,
	): Promise<T> {
		const until = performance.now() + milliseconds;
		while (performance.now() < until) {
			this.options.signal.throwIfAborted();
			if (this.child.exitCode === nativeLeadBusyCode)
				throw Error("Native lead ownership conflict");
			if (
				this.unavailable ||
				this.child.exitCode !== null ||
				this.child.signalCode !== null
			)
				throw Error("Native lead runtime exited before verified receipt");
			if (
				reportsNativeAuthenticationFailure(
					await this.transcript(),
					this.session,
				)
			)
				throw Error("Native authentication_failed in this generation");
			if (
				await stageRefused(
					transcriptPath(this.config, this.options.cwd, this.session),
					this.session,
					this.startedAt,
				)
			)
				throw Error("Native lead refused");
			const result = await check();
			if (result) return result;
			await delay(250, undefined, { signal: this.options.signal });
		}
		throw Error("Native lead receipt timed out; reconcile the dispatch");
	}
	private async submit(prompt: string, nonce: string) {
		const write = (text: string) =>
			new Promise<void>((resolve, reject) =>
				this.child.stdin.write(text, (error) =>
					error ? reject(error) : resolve(),
				),
			);
		await write(prompt);
		await this.wait(
			async () => (await optionalText(this.terminal)).includes(nonce),
			15000,
		);
		await write("\r");
		return this.wait(async () => {
			const rows = await this.transcript();
			const index = rows.findIndex(
				(row) =>
					row.type === "user" && !row.isMeta && row.message?.content === prompt,
			);
			return index < 0 ? undefined : index + 1;
		}, 60000);
	}
	private async member(name: string, agentType = actorType) {
		const existing = this.actors.get(name);
		if (existing && existing.initial.agentType !== agentType)
			throw Error("Native member capability changed within one generation");
		if (existing) return existing;
		const token = randomUUID();
		const initial = {
			config: this.config,
			cwd: this.options.cwd,
			session: this.session,
			name,
			agentType,
			challenge: token,
			expected: token,
		};
		const prompt =
			"Use Agent once to spawn " +
			name +
			" as " +
			agentType +
			". Tell it: Bootstrap " +
			token +
			". Wait for that exact token to arrive and end your turn. Keep the teammate available.";
		const startedAt = Date.now(),
			turn = await this.submit(prompt, token);
		await this.wait(async () => {
			if (await nativeDispatchRefused(initial, startedAt))
				throw Error("Native member refused its bootstrap");
			return (
				(await this.endedAfterDelivery(turn, name, token)) &&
				(await mailboxReceipt(initial))
			);
		});
		const handle = await this.workspace.enroll(initial),
			actor = { initial, handle };
		await claimJson(join(this.directory, "members", name + ".json"), actor);
		this.actors.set(name, actor);
		return actor;
	}
	async dispatch(job: Request) {
		return this.startDispatch(job).completion;
	}
	startDispatch(job: Request) {
		return this.begin(job);
	}
	async startRole(
		job: RoleStage,
		authority: NativeWorkerIntent,
		authorize: () => Promise<void>,
	) {
		const stageDigest = fingerprint(
			job.workspaceManifest
				? JSON.stringify([job.input, job.workspaceManifest])
				: job.input,
		);
		if (
			job.state !== this.options.state ||
			job.cwd !== this.options.cwd ||
			job.issue !== authority.issue ||
			job.role !== authority.role ||
			stageDigest !== authority.inputDigest ||
			(job.effort && job.effort !== this.options.effort)
		)
			throw Error(
				"Native role differs from its approved stage or configured effort",
			);
		const { name, agentType } = persistentNativeActor(
			authority.role,
			authority.issue,
		);
		const { system } = nativeRoleInstructions(
			job.role,
			Boolean(job.workspaceManifest),
		);
		const input =
			system +
			"\n\n" +
			(await nativeRoleInput(job.state, job.issue, job.input));
		const beforeSend = async () => {
			await authorize();
			const db = new DatabaseSync(join(job.state, "intake.sqlite"), {
				readOnly: true,
			});
			try {
				if (!nativeWorkerOwnsParkedStage(db, authority))
					throw Error(
						"Native role requires the exact parked stage and a clear review barrier",
					);
			} finally {
				db.close();
			}
		};
		return this.begin({
			name,
			agentType,
			challenge: authority.challenge,
			issue: job.issue,
			input,
			workspaceManifest: job.workspaceManifest,
			authority,
			beforeSend,
		});
	}
	private begin(job: Request | AuthorizedRequest) {
		if (
			!safeInput.test(job.name) ||
			!safeInput.test(job.challenge) ||
			!Number.isSafeInteger(job.issue) ||
			job.issue < 1 ||
			!job.input.trim() ||
			Buffer.byteLength(job.input) > 80000
		)
			throw Error("Invalid persistent native dispatch");
		if (this.unavailable)
			throw Error("Native lead is unavailable; reconcile the generation");
		if (this.activeMembers.has(job.name) || this.activeMembers.size >= 2)
			throw Error(
				"Native member or generation already has its allowed dispatch load",
			);
		const authority =
			"authority" in job ? nativeWorkerAuthority(job.authority) : undefined;
		if (
			"authority" in job &&
			(job.authority.issue !== job.issue ||
				job.authority.challenge !== job.challenge)
		)
			throw Error("Native dispatch authority differs from its stage");
		this.activeMembers.add(job.name);
		let acknowledge!: (value: DispatchAcknowledgement) => void;
		let rejectAcknowledgement!: (error: unknown) => void;
		const acknowledgement = new Promise<DispatchAcknowledgement>(
			(resolve, reject) => {
				acknowledge = resolve;
				rejectAcknowledgement = reject;
			},
		);
		const completion = this.completeDispatch(
			job,
			acknowledge,
			authority,
		).finally(() => {
			this.completions.delete(completion);
			this.activeMembers.delete(job.name);
		});
		void completion.catch(rejectAcknowledgement);
		void acknowledgement.catch(() => undefined);
		this.completions.add(completion);
		return { acknowledgement, completion };
	}
	private async completeDispatch(
		job: Request | AuthorizedRequest,
		acknowledge: (value: DispatchAcknowledgement) => void,
		authority?: string,
	) {
		let registered = false;
		try {
			const launch = this.writes.then(async () => {
				if (this.unavailable)
					throw Error("Native lead is unavailable; reconcile the generation");
				if (await optionalText(intents(this.options.state, job.challenge)))
					throw Error("Persistent dispatch already requires reconciliation");
				const authorized = "authority" in job ? job : undefined;
				await authorized?.beforeSend();
				const { initial, handle } = await this.member(
					job.name,
					authorized?.agentType,
				);
				const request = "Challenge " + job.challenge + "\n" + job.input;
				const prompt =
					"Use SendMessage to " +
					job.name +
					" exactly once. Send this exact JSON-decoded message: " +
					JSON.stringify(request) +
					". After the tool confirms delivery, reply SENT and immediately end your turn without waiting for a member reply. Do not spawn or contact another teammate.";
				let workspacePin: string | undefined;
				if (job.workspaceManifest) {
					const manifest = join(
						this.directory,
						"manifests",
						job.challenge + ".json",
					);
					const scope = await loadWorkspace(job.workspaceManifest);
					if (
						authorized &&
						scope.identity.revision !== authorized.authority.revision
					)
						throw Error("Native workspace revision differs from its stage");
					workspacePin = await bindWorkspace(
						manifest,
						scope,
						{
							session: this.session,
							member: job.name,
							challenge: job.challenge,
						},
						join(this.directory, "reads", job.challenge + ".jsonl"),
					);
					await mkdir(join(this.directory, "reads"), {
						recursive: true,
						mode: 0o700,
					});
					this.workspace.prepare({
						id: job.challenge,
						session: this.session,
						member: job.name,
						handle,
						manifest,
						digest: workspacePin,
						transcript: transcriptPath(
							this.config,
							this.options.cwd,
							this.session,
						),
						promptDigest: workspaceDigest(prompt),
						requestDigest: workspaceDigest(request),
					});
					registered = true;
				}
				const intent: Intent = {
					version: authority ? 3 : 2,
					issue: job.issue,
					initial,
					handle,
					prompt,
					request,
					challenge: job.challenge,
					workspacePin,
					authority,
				};
				if (
					!(await claimJson(intents(this.options.state, job.challenge), intent))
				)
					throw Error("Persistent dispatch already requires reconciliation");
				await authorized?.beforeSend();
				const startedAt = Date.now(),
					turn = await this.submit(prompt, job.challenge);
				const transcript = transcriptPath(
					this.config,
					this.options.cwd,
					this.session,
				);
				const promptId = (await this.transcript())[turn - 1]?.promptId;
				if (!promptId)
					throw Error("Native follow-up has no original prompt identity");
				await this.wait(
					async () =>
						(await this.endedAfter(turn)) &&
						(await nativeWorkspaceTurn(
							transcript,
							this.session,
							promptId,
							job.name,
							workspaceDigest(prompt),
							workspaceDigest(request),
						)),
				);
				acknowledge({
					session: this.session,
					member: job.name,
					handle,
					challenge: job.challenge,
					promptId,
				});
				return { initial, intent, startedAt };
			});
			this.writes = launch.then(
				() => {},
				() => {
					this.unavailable = true;
				},
			);
			const { initial, intent, startedAt } = await launch;
			const result = await this.wait(async () => {
				if (await nativeDispatchRefused(initial, startedAt))
					throw Error("Native member refused the assigned dispatch");
				return nativeFollowupReceipt({
					...intent,
					allowOtherMembers: true,
					allowLaterDelivery: true,
				});
			});
			const workspaceEvidence = await sharedWorkspaceEvidence(
				this.directory,
				intent,
				this.workspace,
			);
			const receipt = {
				developer: result.handle,
				nativeMember: result.nativeMember,
				backend: "in-process" as const,
				team: "session-" + this.session.slice(0, 8),
				output: result.output,
				...(workspaceEvidence ? { workspaceEvidence } : {}),
			};
			if (registered) {
				registered = false;
				this.workspace.retire(job.challenge);
			}
			await atomicJson(
				join(this.directory, "receipts", job.challenge + ".json"),
				receipt,
			);
			return receipt;
		} catch (error) {
			this.unavailable = true;
			if (registered) {
				try {
					this.workspace.retire(job.challenge);
				} catch (retirement) {
					throw new AggregateError([error, retirement], String(error), {
						cause: error,
					});
				}
			}
			throw error;
		}
	}
	private closing?: Promise<void>;
	close() {
		this.closing ??= this.dispose();
		return this.closing;
	}
	private async dispose() {
		this.unavailable = true;
		this.child.kill("SIGTERM");
		await Promise.race([this.closed, delay(5000)]);
		if (this.child.exitCode === null && this.child.signalCode === null)
			this.child.kill("SIGKILL");
		await this.closed;
		await Promise.allSettled(this.completions);
		this.workspace.close();
	}
}
