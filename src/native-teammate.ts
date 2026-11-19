// Instrumentation for the Ubuntu image's pinned Claude Code 2.1.325 Agent Teams protocol.
import {
	mkdir,
	open,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { nativeLeadBusyCode, startNativeLead } from "./native-lead.js";
import { claimJson } from "./storage.js";
import { createHash } from "node:crypto";
import { loadWorkspace } from "./workspace-binding.js";

interface Block {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	tool_use_id?: string;
	input?: {
		name?: string;
		subagent_type?: string;
		to?: string;
		message?: string;
		prompt?: string;
		root?: string;
		path?: string;
	};
	is_error?: boolean;
	content?: string | { text?: string }[];
}
interface Row {
	sessionId?: string;
	cwd?: string;
	agentId?: string;
	promptId?: string;
	isMeta?: boolean;
	type: string;
	subtype?: string;
	timestamp?: string;
	message?: { content?: string | Block[]; stop_reason?: string };
}
interface Roster {
	leadSessionId: string;
	members: {
		name: string;
		agentId: string;
		cwd: string;
		backendType: string;
	}[];
}

async function optionalText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function rows(path: string): Promise<Row[]> {
	const text = await optionalText(path);
	const lines = text.split("\n");
	const tail = lines.pop();
	const parsed: Row[] = lines.filter(Boolean).map((line) => JSON.parse(line));
	// A completed harness row need not have a trailing newline. Ignore only a
	// genuinely partial final JSON object while the writer is appending it.
	if (tail) {
		try {
			parsed.push(JSON.parse(tail));
		} catch {}
	}
	return parsed;
}

export function nativeMailboxBody(
	message: string,
	name: string,
): string | undefined {
	const greeting = "Another Claude session sent a message:\n";
	if (!message.startsWith(greeting)) return;
	const text = message.slice(greeting.length),
		split = text.indexOf("\n");
	if (split < 0) return;
	const opening = text.slice(0, split);
	const teammate = '<teammate-message teammate_id="' + name + '"';
	const close =
		opening === '<agent-message from="' + name + '">'
			? "</agent-message>"
			: opening.startsWith(teammate) &&
					/^(?: [^>\r\n]*)?>$/.test(opening.slice(teammate.length))
				? "</teammate-message>"
				: undefined;
	if (!close) return;
	const closing = "\n" + close;
	const end = text.indexOf(closing, split + 1);
	if (
		end >= 0 &&
		(text.length === end + closing.length ||
			text[end + closing.length] === "\n")
	)
		return text.slice(split + 1, end);
}

export function exactNativeTerminalSubmission(
	content: unknown,
	prompt: string,
	allowCompactPaste = false,
) {
	if (content === prompt) return true;
	if (typeof content !== "string") return false;
	return nativePastedContent(content, allowCompactPaste) === prompt;
}

function nativePastedContent(content: string, allowCompactPaste: boolean) {
	const formatted =
		/^\n\n<pasted_content id="([a-f0-9]{4})">\n([\s\S]*)\n<\/pasted_content id="\1">\n$/.exec(
			content,
		)?.[2];
	return (
		formatted ??
		(allowCompactPaste
			? /^<pasted_content id="([a-f0-9]{4})">\n([\s\S]*)\n<\/pasted_content id="\1">$/.exec(
					content,
				)?.[2]
			: undefined)
	);
}

export function nativeTerminalPasteEnabled(rendered: string) {
	return (
		rendered.lastIndexOf("\x1b[?2004h") > rendered.lastIndexOf("\x1b[?2004l")
	);
}

export function nativeTerminalPasteDisplayed(
	rendered: string,
	challenge: string,
) {
	const plain = rendered.replaceAll(
		new RegExp(String.fromCharCode(27) + "\\[[0-?]*[ -/]*[@-~]", "g"),
		"",
	);
	return (
		plain.includes(challenge) ||
		/\[Pasted\s*text\s*#\d+[^\]\r\n]*\]/i.test(plain)
	);
}

// The pinned harness leaves its interactive process open after a terminal model refusal.
export async function stageRefused(
	log: string,
	session: string,
	startedAt: number,
	actor?: { handle: string; cwd: string },
	completedAt = Infinity,
) {
	const file = await open(log, "r").catch((err: NodeJS.ErrnoException) => {
		if (err.code !== "ENOENT") throw err;
		return undefined;
	});
	if (!file) return false;
	const input = file.createReadStream({ autoClose: false }),
		lines = createInterface({ input, crlfDelay: Infinity });
	const refused = (line: string, partial: boolean) => {
		if (!line.includes('"refusal"') && !line.includes("model_refusal_fallback"))
			return false;
		let row: Row & { timestamp: string };
		try {
			row = JSON.parse(line);
		} catch (error) {
			if (partial) return false;
			throw error;
		}
		const recorded = Date.parse(row.timestamp);
		return (
			row.sessionId === session &&
			recorded >= startedAt &&
			recorded <= completedAt &&
			(!actor || (row.agentId === actor.handle && row.cwd === actor.cwd)) &&
			((row.type === "assistant" && row.message?.stop_reason === "refusal") ||
				(row.type === "system" && row.subtype === "model_refusal_fallback"))
		);
	};
	try {
		let pending: string | undefined;
		for await (const line of lines) {
			if (pending !== undefined && refused(pending, false)) return true;
			pending = line;
		}
		return pending !== undefined && refused(pending, true);
	} finally {
		lines.close();
		input.destroy();
		await file.close();
	}
}

export interface TeammateJob {
	state: string;
	cwd: string;
	session: string;
	name: string;
	agentType: string;
	challenge: string;
	system: string;
	prompt: string;
	expected?: string;
	signal: AbortSignal;
	workspaceManifest?: string;
	workspacePin?: string;
	effort?: "low" | "medium" | "high";
}

interface ReceiptQuery {
	config: string;
	cwd: string;
	session: string;
	name: string;
	agentType: string;
	challenge: string;
	expected?: string;
}

async function nativeSpawn({
	config,
	cwd,
	session,
	name,
	agentType,
	challenge,
}: ReceiptQuery) {
	const team = "session-" + session.slice(0, 8);
	const raw = await optionalText(join(config, "teams", team, "config.json"));
	if (raw) {
		let roster: Roster;
		try {
			roster = JSON.parse(raw);
		} catch {
			return;
		}
		const member = roster.members?.find(
			(m) => m.name === name && m.backendType === "in-process" && m.cwd === cwd,
		);
		if (
			roster.leadSessionId !== session ||
			member?.agentId !== name + "@" + team
		)
			return;
	}

	const prefix = join(
		config,
		"projects",
		cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
		session,
	);
	const leadRows = (await rows(prefix + ".jsonl")).filter(
		(r) => r.sessionId === session,
	);
	const blocks = leadRows.flatMap((row) =>
		Array.isArray(row.message?.content) ? row.message.content : [],
	);
	const spawns = blocks.filter(
		(b) =>
			b.type === "tool_use" &&
			b.name === "Agent" &&
			b.input?.name === name &&
			b.input?.subagent_type === agentType &&
			b.input?.prompt?.includes(challenge),
	);
	const callIds = new Set(spawns.map((b) => b.id).filter(Boolean));
	if (callIds.size !== 1) return;
	const result = blocks.find(
		(b) => b.type === "tool_result" && callIds.has(b.tool_use_id),
	);
	if (result?.is_error)
		throw Error(
			"Native teammate spawn was declined or interrupted by the harness; reconcile before another execution",
		);
	const summary =
		typeof result?.content === "string"
			? result.content
			: result?.content?.map((c) => c.text).join("\n");
	const handle = summary?.match(/^agent_id: ([\w-]+)$/m)?.[1];
	if (!handle) return;

	const log = join(prefix, "subagents", "agent-" + handle + ".jsonl");
	const workerRows = await rows(log);
	if (!raw) {
		// Closing the native team retires its roster. The per-member harness metadata survives.
		const archived = await optionalText(
			join(prefix, "subagents", "agent-" + handle + ".meta.json"),
		);
		if (!archived) return;
		let meta: {
			name?: string;
			teamName?: string;
			taskKind?: string;
			customAgentType?: string;
			spawnedAgentType?: string;
		};
		try {
			meta = JSON.parse(archived);
		} catch {
			return;
		}
		if (
			meta.name !== name ||
			meta.teamName !== team ||
			meta.taskKind !== "in_process_teammate" ||
			meta.customAgentType !== agentType ||
			meta.spawnedAgentType !== agentType ||
			!workerRows.some(
				(row) =>
					row.agentId === handle &&
					row.sessionId === session &&
					row.cwd === cwd,
			)
		)
			return;
	}
	return { leadRows, workerRows, log, handle, team };
}

export async function nativeDispatchRefused(
	query: ReceiptQuery,
	startedAt: number,
	completedAt?: number,
) {
	const { config, cwd, session } = query;
	const lead = join(
		config,
		"projects",
		cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
		session + ".jsonl",
	);
	if (await stageRefused(lead, session, startedAt, undefined, completedAt))
		return true;
	const owner = await nativeSpawn(query);
	return (
		!!owner &&
		(await stageRefused(
			owner.log,
			session,
			startedAt,
			{ handle: owner.handle, cwd },
			completedAt,
		))
	);
}

export async function mailboxReceipt(query: ReceiptQuery) {
	const { name, challenge, expected } = query;
	const spawn = await nativeSpawn(query);
	if (!spawn) return;
	const { leadRows, workerRows, handle, team } = spawn;
	const messages = new Set<string>();
	const finalOutputs = new Set<string>();
	const valid = (value: unknown): value is string =>
		typeof value === "string" &&
		value.length <= 65536 &&
		(expected !== undefined
			? value.trim() === expected
			: value.trimStart().startsWith(challenge + "\n"));
	for (const row of workerRows) {
		if (row.type !== "assistant" || !Array.isArray(row.message?.content))
			continue;
		for (const block of row.message.content) {
			if (
				block.type === "tool_use" &&
				block.name === "SendMessage" &&
				["main", "team-lead"].includes(block.input?.to ?? "") &&
				valid(block.input?.message)
			)
				messages.add(block.input.message);
			if (
				block.type === "text" &&
				row.message.stop_reason === "end_turn" &&
				valid(block.text)
			)
				finalOutputs.add(block.text);
		}
	}
	const delivered = new Set<string>();
	for (const row of leadRows) {
		const body = row.message?.content;
		if (
			row.type !== "user" ||
			typeof body !== "string" ||
			!body.startsWith("Another Claude session sent a message:\n")
		)
			continue;
		for (const answer of messages)
			if (
				[answer, answer.trim()].some(
					(text) =>
						body.includes(
							'<agent-message from="' +
								name +
								'">\n' +
								text +
								"\n</agent-message>",
						) ||
						(body.includes('<teammate-message teammate_id="' + name + '"') &&
							body.includes(">\n" + text + "\n</teammate-message>")),
				)
			)
				delivered.add(answer);
		const envelope =
			/^Another Claude session sent a message:\n<teammate-message teammate_id="([^"]+)"[^>]*>\n([^\n]*)\n<\/teammate-message>(?:\n|$)/.exec(
				body,
			);
		if (!envelope || envelope[1] !== name) continue;
		let notice: {
			type?: string;
			from?: string;
			idleReason?: string;
			result?: unknown;
		} | null;
		try {
			notice = JSON.parse(envelope[2]!);
		} catch {
			continue;
		}
		if (
			notice?.type !== "idle_notification" ||
			notice.from !== name ||
			notice.idleReason !== "available" ||
			!valid(notice.result)
		)
			continue;
		// The harness retains the complete turn locally, but abbreviates its automatic mailbox preview.
		for (const full of finalOutputs) {
			const preview =
				full.length > 4000
					? full.slice(0, 4000) +
						"\n[result truncated — ask the agent for the rest via SendMessage]"
					: full;
			if (notice.result === full || notice.result === preview)
				delivered.add(full);
		}
	}
	const deliveries = [...delivered];
	if (deliveries.length > 1)
		throw new Error("Ambiguous native teammate output");
	if (deliveries.length === 1)
		return {
			developer: handle,
			nativeMember: name + "@" + team,
			backend: "in-process",
			team,
			output:
				expected === undefined
					? deliveries[0]!.trimStart().slice(challenge.length + 1)
					: deliveries[0]!.trim(),
		};
}

export async function teammateReceipt(
	config: string,
	cwd: string,
	session: string,
	name: string,
	challenge: string,
	answer: string,
) {
	return mailboxReceipt({
		config,
		cwd,
		session,
		name,
		challenge,
		agentType: "jam-developer",
		expected: answer,
	});
}

export interface NativeWorkspaceEvidence {
	advertised: boolean;
	memberCalls: number;
	sourceRead: boolean;
	specificationIndexRead: boolean;
}
export async function nativeWorkspaceEvidence(
	state: string,
	issue: number,
	role: string,
	revision: string,
	query: ReceiptQuery,
	developer: string,
): Promise<NativeWorkspaceEvidence | undefined> {
	const { session, name, challenge } = query;
	if (
		!/^[a-f0-9-]{36}$/.test(challenge) ||
		!/^[a-z]+$/.test(role) ||
		!Number.isSafeInteger(issue) ||
		issue < 1
	)
		return;
	const intent = await optionalText(
		join(state, "native-dispatches", challenge + ".json"),
	);
	if (!intent) return;
	const saved = JSON.parse(intent);
	if (
		saved.version !== 2 ||
		saved.session !== session ||
		saved.name !== name ||
		saved.challenge !== challenge ||
		typeof saved.workspacePin !== "string" ||
		saved.agentType !== query.agentType
	)
		return;
	const prefix = join(
		state,
		"assignments",
		String(issue),
		"workspace-access",
		role + "-" + challenge,
	);
	const binding = { session, member: name, challenge };
	const manifest = await loadWorkspace(prefix + ".manifest.json", {
		digest: saved.workspacePin,
		binding,
	});
	if (
		manifest.identity.revision !== revision ||
		manifest.audit !== prefix + ".jsonl"
	)
		return;
	const native = await nativeSpawn(query);
	if (!native || native.handle !== developer) return;
	return boundWorkspaceEvidence(manifest, query, developer, native.workerRows);
}

async function boundWorkspaceEvidence(
	manifest: Awaited<ReturnType<typeof loadWorkspace>>,
	query: ReceiptQuery,
	developer: string,
	workerRows: Row[],
	usedCalls?: ReadonlySet<string>,
	catalogAdvertised = false,
): Promise<NativeWorkspaceEvidence | undefined> {
	const { session, name } = query;
	const challenge = manifest.binding?.challenge;
	const { revision } = manifest.identity;
	if (
		!manifest.audit ||
		!challenge ||
		manifest.binding?.session !== session ||
		manifest.binding.member !== name
	)
		return;
	const events = (await optionalText(manifest.audit))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter(
			(event) =>
				event.binding?.session === session &&
				event.binding?.member === name &&
				event.binding?.challenge === challenge &&
				event.identity?.revision === revision &&
				event.identity?.specifications === manifest.identity.specifications,
		);
	const calls = workerRows
		.filter(
			(row) =>
				row.agentId === developer &&
				row.sessionId === session &&
				row.cwd === query.cwd,
		)
		.flatMap((row) =>
			Array.isArray(row.message?.content) ? row.message.content : [],
		);
	const toolbox = ["workspace_list", "workspace_read", "workspace_search"];
	const member = new Set(
		calls
			.filter(
				(block) =>
					block.type === "tool_use" &&
					(!usedCalls || (block.id && usedCalls.has(block.id))) &&
					toolbox.some((tool) => block.name === "mcp__jam_workspace__" + tool),
			)
			.map((call) => call.id)
			.filter(Boolean),
	);
	const read = (root: string, path: (file: string) => boolean) =>
		calls.some((block, index) => {
			const file = block.input?.path;
			if (
				block.type !== "tool_use" ||
				block.name !== "mcp__jam_workspace__workspace_read" ||
				!block.id ||
				(usedCalls && !usedCalls.has(block.id)) ||
				block.input?.root !== root ||
				typeof file !== "string" ||
				!path(file) ||
				!events.some(
					(event) =>
						event.operation === "read" &&
						event.root === root &&
						event.path === file &&
						event.bytes > 0,
				)
			)
				return false;
			return calls.slice(index + 1).some((result) => {
				if (
					result.type !== "tool_result" ||
					result.tool_use_id !== block.id ||
					result.is_error
				)
					return false;
				try {
					const raw =
						typeof result.content === "string"
							? result.content
							: result.content?.map((value) => value.text).join("\n");
					const value = JSON.parse(raw ?? "");
					return (
						value.path === file &&
						value.bytes > 0 &&
						value.identity?.revision === revision &&
						value.identity?.specifications === manifest.identity.specifications
					);
				} catch {
					return false;
				}
			});
		});
	return {
		advertised:
			catalogAdvertised ||
			events.some(
				(event) =>
					event.operation === "tools-list" &&
					toolbox.every(
						(tool) => Array.isArray(event.tools) && event.tools.includes(tool),
					),
			),
		memberCalls: member.size,
		sourceRead: read("repository", (file) =>
			/\.(?:[cm]?[jt]sx?|html?|css)$/i.test(file),
		),
		specificationIndexRead: read(
			"specifications",
			(file) => file === "index.json",
		),
	};
}

export async function nativeSharedWorkspaceEvidence(
	query: ReceiptQuery,
	handle: string,
	manifest: Awaited<ReturnType<typeof loadWorkspace>>,
	usedCalls: ReadonlySet<string>,
	catalogAdvertised: boolean,
) {
	const native = await nativeSpawn(query);
	if (!native || native.handle !== handle) return;
	return boundWorkspaceEvidence(
		manifest,
		query,
		handle,
		native.workerRows,
		usedCalls,
		catalogAdvertised,
	);
}

interface FollowupQuery {
	initial: ReceiptQuery;
	handle: string;
	prompt: string;
	request: string;
	challenge: string;
	allowOtherMembers?: boolean;
	allowLaterDelivery?: boolean;
}

function sendResult(
	log: Row[],
	recipient: (value: string) => boolean,
	body: (value: string) => boolean,
) {
	const sends = new Map<string, { message: string; position: number }>();
	for (const [position, row] of log.entries()) {
		if (row.type !== "assistant" || !Array.isArray(row.message?.content))
			continue;
		for (const block of row.message.content) {
			const { id, input } = block;
			if (
				block.type === "tool_use" &&
				block.name === "SendMessage" &&
				id &&
				typeof input?.message === "string" &&
				typeof input.to === "string" &&
				recipient(input.to) &&
				body(input.message)
			) {
				const previous = sends.get(id);
				if (previous && previous.message !== input.message)
					throw Error("Conflicting native SendMessage call");
				if (!previous) sends.set(id, { message: input.message, position });
			}
		}
	}
	if (sends.size > 1) throw Error("Ambiguous native SendMessage call");
	const [send] = sends;
	if (!send) return;
	const [id, { message, position }] = send;
	let acknowledgedAt: number | undefined;
	for (const [index, row] of log.slice(position + 1).entries()) {
		if (row.type !== "user" || !Array.isArray(row.message?.content)) continue;
		for (const result of row.message.content) {
			if (result.type !== "tool_result" || result.tool_use_id !== id) continue;
			const raw =
				typeof result.content === "string"
					? result.content
					: result.content?.map((block) => block.text).join("\n");
			let payload: { success?: boolean } | null;
			try {
				payload = JSON.parse(raw ?? "");
			} catch {
				throw Error("Unverified native SendMessage result");
			}
			if (result.is_error || payload?.success !== true)
				throw Error("Native SendMessage did not succeed");
			acknowledgedAt ??= position + index + 1;
		}
	}
	if (acknowledgedAt !== undefined) return { id, message, acknowledgedAt };
}

export async function nativeWorkspaceTurn(
	transcript: string,
	session: string,
	promptId: string,
	member: string,
	promptDigest: string,
	requestDigest: string,
) {
	const lead = (await rows(transcript)).filter(
		(row) => row.sessionId === session && !row.agentId,
	);
	const initial = lead.filter(
		(row) =>
			row.type === "user" &&
			!row.isMeta &&
			row.promptId === promptId &&
			typeof row.message?.content === "string" &&
			[
				row.message.content,
				nativePastedContent(row.message.content, true),
			].some(
				(text) =>
					text !== undefined &&
					createHash("sha256").update(text).digest("hex") === promptDigest,
			),
	);
	if (initial.length !== 1) return false;
	const turn = lead.slice(lead.indexOf(initial[0]!) + 1);
	const end = turn.findIndex(
		(row) =>
			row.type === "user" &&
			!row.isMeta &&
			typeof row.message?.content === "string" &&
			row.promptId !== promptId,
	);
	const sameTurn = end < 0 ? turn : turn.slice(0, end);
	const team = "session-" + session.slice(0, 8);
	return Boolean(
		sendResult(
			sameTurn,
			(id) => id === member || id === member + "@" + team,
			(text) =>
				createHash("sha256").update(text).digest("hex") === requestDigest,
		),
	);
}

export async function nativeFollowupReceipt({
	initial,
	handle,
	prompt,
	request,
	challenge,
	allowOtherMembers = false,
	allowLaterDelivery = false,
}: FollowupQuery) {
	const { config, cwd, session, name } = initial;
	if (
		challenge === initial.challenge ||
		!request.includes(challenge) ||
		(!prompt.includes(request) && !prompt.includes(JSON.stringify(request))) ||
		!/^[-\w]+$/.test(challenge)
	)
		throw Error("Invalid native follow-up input");
	const original = await mailboxReceipt(initial);
	if (original?.developer !== handle) return;
	const prefix = join(
		config,
		"projects",
		cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
		session,
	);
	const lead = (await rows(prefix + ".jsonl")).filter(
		(row) => row.sessionId === session && row.cwd === cwd && !row.agentId,
	);
	const agentCalls = lead
		.flatMap((row) =>
			row.type === "assistant" && Array.isArray(row.message?.content)
				? row.message.content
				: [],
		)
		.filter(
			(block) =>
				block.type === "tool_use" &&
				block.name === "Agent" &&
				(!allowOtherMembers || block.input?.name === name),
		);
	if (
		new Set(agentCalls.map((block) => block.id)).size !== 1 ||
		agentCalls.some((block) => !block.id)
	)
		throw Error("Expected exactly one native roster spawn");
	const submitted = lead.filter(
		(row) =>
			row.type === "user" &&
			!row.isMeta &&
			(row.message?.content === prompt ||
				(allowLaterDelivery &&
					exactNativeTerminalSubmission(row.message?.content, prompt, true))),
	);
	if (submitted.length > 1)
		throw Error("Duplicate native follow-up submission");
	const [turn] = submitted;
	if (!turn?.timestamp) return;
	const since = Date.parse(turn.timestamp);
	if (!Number.isFinite(since)) return;
	const following = lead.slice(lead.indexOf(turn) + 1);
	const next = following.findIndex(
		(row) =>
			row.type === "user" &&
			!row.isMeta &&
			typeof row.message?.content === "string" &&
			!row.message.content.startsWith(
				"Another Claude session sent a message:\n",
			),
	);
	const leadTurn = next < 0 ? following : following.slice(0, next);
	const members = await rows(
		join(prefix, "subagents", "agent-" + handle + ".jsonl"),
	);
	const member = members.filter(
		(row) =>
			row.agentId === handle &&
			row.sessionId === session &&
			row.cwd === cwd &&
			Date.parse(row.timestamp ?? "") >= since,
	);
	const refused = (row: Row) =>
		(row.type === "assistant" && row.message?.stop_reason === "refusal") ||
		(row.type === "system" && row.subtype === "model_refusal_fallback");
	const deliveryRows = allowLaterDelivery ? following : leadTurn;
	if (deliveryRows.some(refused))
		throw Error("Native lead refused the follow-up");
	const outgoing = sendResult(
		leadTurn,
		(id) => id === name || id === original.nativeMember,
		(text) => text === request,
	);
	if (!outgoing) return;
	const incoming = member.filter((row) => {
		const text = row.message?.content;
		if (row.type !== "user" || typeof text !== "string") return false;
		const header = text.indexOf("\n");
		return (
			/^<teammate-message teammate_id="team-lead"(?: [^>\r\n]*)?>$/.test(
				text.slice(0, header),
			) && text.slice(header + 1) === request + "\n</teammate-message>"
		);
	});
	if (incoming.length > 1)
		throw Error("Duplicate native follow-up delivery to member");
	const [delivery] = incoming;
	if (!delivery) {
		if (member.some(refused))
			throw Error("Native member refused without an attributable follow-up");
		return;
	}
	const memberFollowing = member.slice(member.indexOf(delivery) + 1);
	const nextMember = memberFollowing.findIndex(
		(row) =>
			row.type === "user" &&
			typeof row.message?.content === "string" &&
			(!row.isMeta || row.message.content.startsWith("<teammate-message ")),
	);
	const memberTurn =
		nextMember < 0 ? memberFollowing : memberFollowing.slice(0, nextMember);
	if (memberTurn.some(refused))
		throw Error("Native member refused the follow-up");
	const reply = sendResult(
		memberTurn,
		(id) => id === "main" || id === "team-lead",
		(text) =>
			text.length <= 65536 &&
			(text === challenge || text.startsWith(challenge + "\n")),
	);
	if (!reply) return;
	const firstDeliveryRow = outgoing.acknowledgedAt + 1;
	const deliveries = deliveryRows
		.slice(firstDeliveryRow)
		.filter(
			(row, index) =>
				row.type === "user" &&
				(firstDeliveryRow + index < leadTurn.length || row.isMeta === true) &&
				typeof row.message?.content === "string" &&
				nativeMailboxBody(row.message.content, name) === reply.message,
		);
	if (allowLaterDelivery && deliveries.length > 1)
		throw Error("Ambiguous native follow-up observation");
	if (!deliveries.length) return;
	return {
		nativeMember: original.nativeMember,
		handle,
		dispatchId: outgoing.id,
		replyId: reply.id,
		output: reply.message.slice(challenge.length).replace(/^\n/, ""),
	};
}

const sessionRuns = new Map<string, Promise<void>>();
export async function runNativeJob(job: TeammateJob) {
	const key = job.cwd + "\0" + job.session;
	const previous = sessionRuns.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	sessionRuns.set(key, current);
	try {
		await previous;
		job.signal.throwIfAborted();
		return await executeNativeJob(job);
	} finally {
		release();
		if (sessionRuns.get(key) === current) sessionRuns.delete(key);
	}
}

async function executeNativeJob({
	state,
	cwd,
	session,
	name,
	agentType,
	challenge,
	system,
	prompt,
	expected,
	signal,
	workspaceManifest,
	workspacePin,
	effort,
}: TeammateJob) {
	const config = await realpath(
		process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
	);
	const home = join(state, "worker-runtime-home");
	await mkdir(home, { recursive: true, mode: 0o700 });
	try {
		await symlink(config, join(home, ".claude"));
	} catch (err) {
		if (
			(err as NodeJS.ErrnoException).code !== "EEXIST" ||
			(await realpath(join(home, ".claude"))) !== config
		)
			throw err;
	}
	// Isolate CLI onboarding/trust from the user's home. Only the service-owned, fixed cwd is trusted.
	try {
		await writeFile(
			join(home, ".claude.json"),
			JSON.stringify({
				hasCompletedOnboarding: true,
				theme: "dark",
				numStartups: 2,
				projects: { [cwd]: { hasTrustDialogAccepted: true } },
			}),
			{ flag: "wx", mode: 0o600 },
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const workspaceTools = workspaceManifest
		? [
				"mcp__jam_workspace__workspace_list",
				"mcp__jam_workspace__workspace_read",
				"mcp__jam_workspace__workspace_search",
			]
		: [];
	const tools = ["Agent", "SendMessage", ...workspaceTools].join(",");
	const agents = {
		[agentType]: {
			description: "JAM-Bot " + agentType + " teammate",
			prompt: system,
			tools: ["SendMessage", ...workspaceTools],
		},
	};
	const transcript = join(
		config,
		"projects",
		cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
		session + ".jsonl",
	);
	const established = await realpath(transcript).then(
		() => true,
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return false;
		},
	);
	const warming = Boolean(workspaceManifest && workspacePin && !established);
	if (
		warming &&
		Array.from(prompt).some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	)
		throw Error(
			"Native workspace assignment requires a single terminal-safe prompt",
		);
	const warmup =
		"Reply READY and end this setup turn. Wait for a separate assignment before spawning a teammate.";
	const args = [
		established ? "--resume" : "--session-id",
		session,
		...(workspaceManifest ? ["--system-prompt-snapshot", "off"] : []),
		"--setting-sources",
		"",
		"--settings",
		'{"disableAllHooks":true,"switchModelsOnFlag":false}',
		"--teammate-mode",
		"in-process",
		"--strict-mcp-config",
		...(workspaceManifest
			? [
					"--mcp-config",
					JSON.stringify({
						mcpServers: {
							jam_workspace: {
								alwaysLoad: true,
								command: process.execPath,
								args: [
									new URL("./workspace-mcp.js", import.meta.url).pathname,
									workspaceManifest,
									...(workspacePin
										? [workspacePin, session, name, challenge]
										: []),
								],
							},
						},
					}),
				]
			: []),
		"--tools",
		"Agent,SendMessage",
		"--allowedTools",
		tools,
		"--agents",
		JSON.stringify(agents),
		"--permission-mode",
		"dontAsk",
		"--disable-slash-commands",
		...(effort ? ["--effort", effort] : []),
		"--system-prompt",
		"You are JAM, a native in-process team lead. Forward the stage input to the named native teammate. Wait for its result.",
		warming ? warmup : prompt,
	];
	// script supplies a PTY. Print mode falls back to a different, short-lived subagent.
	// All arguments are POSIX-quoted. Issue text is excluded from the command.
	const startedAt = Date.now();
	let nextStatusCheck = startedAt;
	const diagnostics = join(state, "native-diagnostics");
	await mkdir(diagnostics, { recursive: true, mode: 0o700 });
	const terminal = join(diagnostics, name + ".log");
	if (process.env.JAM_NATIVE_TOOL_DIAGNOSTICS === "1")
		args.push(
			"--debug=mcp,agents",
			"--debug-file",
			join(diagnostics, name + ".debug.log"),
		);
	const shellCommand =
		"exec claude " +
		args.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
	if (!/^[-\w]{1,128}$/.test(challenge))
		throw Error("Invalid native dispatch challenge");
	const intent = join(state, "native-dispatches", challenge + ".json");
	const input = createHash("sha256")
		.update(JSON.stringify({ system, prompt, expected, workspacePin }))
		.digest("hex");
	if (
		!(await claimJson(intent, {
			version: 2,
			session,
			name,
			agentType,
			challenge,
			input,
			workspacePin,
			startedAt,
		}))
	)
		throw Error("Native dispatch ownership requires reconciliation");
	signal.throwIfAborted();
	const child = await startNativeLead(
		state,
		["-qefc", shellCommand, terminal],
		{
			cwd,
			env: {
				...process.env,
				HOME: home,
				TERM: "xterm-256color",
				CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
				...(warming ? { ENABLE_TOOL_SEARCH: "false" } : {}),
			},
		},
	);
	let error = false;
	child.on("error", () => {
		error = true;
	});
	child.stdin.on("error", () => {
		error = true;
	});
	const closed = new Promise<void>((done) => child.once("close", () => done()));
	const query = { config, cwd, session, name, challenge, expected, agentType };
	try {
		// A UI implementation or a substantial synthesis can exceed the short checksum probe.
		const timeout = Number(process.env.JAM_NATIVE_STAGE_TIMEOUT_MINUTES ?? 15);
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60)
			throw Error("Invalid native stage timeout");
		const deadline = Date.now() + timeout * 60_000;
		if (warming) {
			const workspace = await loadWorkspace(workspaceManifest!, {
				digest: workspacePin!,
				binding: { session, member: name, challenge },
			});
			if (!workspace.audit)
				throw Error("Pinned workspace has no catalog audit");
			const awaitReady = async (test: () => Promise<boolean>) => {
				const until = Math.min(deadline, Date.now() + 60_000);
				while (Date.now() < until) {
					signal.throwIfAborted();
					if (child.exitCode === nativeLeadBusyCode)
						throw Error("Native lead ownership conflict during catalog setup");
					if (error || child.exitCode !== null || child.signalCode !== null)
						throw Error("Native workspace lead exited during catalog setup");
					if (await stageRefused(transcript, session, startedAt))
						throw Error("Native model refused this stage during catalog setup");
					if (await test()) return;
					await delay(250, undefined, { signal });
				}
				throw Error("Native workspace catalog or submission was not verified");
			};
			await awaitReady(async () => {
				const lead = (await rows(transcript)).filter(
					(row) => row.sessionId === session && row.cwd === cwd && !row.agentId,
				);
				if (
					lead.some(
						(row) =>
							row.type === "assistant" &&
							Array.isArray(row.message?.content) &&
							row.message.content.some(
								(block) => block.type === "tool_use" && block.name === "Agent",
							),
					)
				)
					throw Error(
						"Native workspace lead attempted delegation during catalog setup",
					);
				if (
					!lead.some(
						(row) =>
							row.type === "assistant" &&
							row.message?.stop_reason === "end_turn",
					)
				)
					return false;
				return (await optionalText(workspace.audit!))
					.split("\n")
					.some((line) => {
						if (!line) return false;
						const event = JSON.parse(line);
						return (
							event.operation === "tools-list" &&
							event.binding?.session === session &&
							event.binding?.member === name &&
							event.binding?.challenge === challenge &&
							Array.isArray(event.tools) &&
							workspaceTools.every((tool) =>
								event.tools.includes(tool.replace("mcp__jam_workspace__", "")),
							)
						);
					});
			});
			const write = (value: string) =>
				new Promise<void>((resolve, reject) =>
					child.stdin.write(value, (error) =>
						error ? reject(error) : resolve(),
					),
				);
			const dispatchPrompt = "JAM dispatch " + challenge + ". " + prompt;
			await awaitReady(async () => {
				return nativeTerminalPasteEnabled(await optionalText(terminal));
			});
			const renderedBefore = (await optionalText(terminal)).length;
			await write("\x1b[200~" + dispatchPrompt + "\x1b[201~");
			await awaitReady(async () => {
				return nativeTerminalPasteDisplayed(
					(await optionalText(terminal)).slice(renderedBefore),
					challenge,
				);
			});
			await write("\r");
			await awaitReady(async () => {
				const submitted = (await rows(transcript)).filter(
					(row) =>
						row.sessionId === session &&
						row.type === "user" &&
						!row.isMeta &&
						exactNativeTerminalSubmission(row.message?.content, dispatchPrompt),
				);
				if (submitted.length > 1)
					throw Error("Duplicate native workspace assignment submission");
				return submitted.length === 1;
			});
		}
		while (Date.now() < deadline) {
			if (signal.aborted) throw new Error("Native teammate interrupted");
			if (child.exitCode === nativeLeadBusyCode)
				throw new Error(
					"Native lead ownership conflict; the previous writer may still be active",
				);
			if (error || child.exitCode !== null || child.signalCode !== null)
				throw new Error(
					"Native teammate runtime exited before verified receipt",
				);
			const receipt = await mailboxReceipt(query);
			if (receipt) {
				if (await nativeDispatchRefused(query, startedAt))
					throw Error(
						"Native model refused this stage; automatic fallback is not an authorized result",
					);
				return receipt;
			}
			if (Date.now() >= nextStatusCheck) {
				nextStatusCheck = Date.now() + 3000;
				if (await nativeDispatchRefused(query, startedAt))
					throw Error(
						"Native model refused this stage; preserve the candidate and reconcile before further work",
					);
			}
			await delay(400);
		}
		throw new Error("Native teammate receipt timed out");
	} finally {
		child.kill("SIGTERM");
		await closed;
	}
}

export async function runTeammate(
	state: string,
	cwd: string,
	session: string,
	issue: number,
	digits: number[],
	challenge: string,
	expected: string,
	signal: AbortSignal,
) {
	const name = "developer-" + issue + "-" + challenge.slice(0, 6);
	const prompt =
		"Use Agent exactly once, set name=" +
		name +
		" and subagent_type=jam-developer. Have this named teammate compute the sum of " +
		digits.join(", ") +
		". Give it the challenge " +
		challenge +
		". It must SendMessage to main with the exact single line " +
		challenge +
		":<sum>, replacing <sum> with its decimal answer. Wait for the native mailbox result.";
	const { output, ...receipt } = await runNativeJob({
		state,
		cwd,
		session,
		name,
		agentType: "jam-developer",
		challenge,
		expected,
		signal,
		prompt,
		system:
			"Compute the requested sum and send the exact requested line to main using SendMessage. Then wait.",
	});
	return receipt;
}
