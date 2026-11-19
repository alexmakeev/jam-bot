import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	exactNativeTerminalSubmission,
	nativeFollowupReceipt,
} from "../src/native-teammate.js";

test("a collapsed terminal paste must retain the exact assignment under its native wrapper", () => {
	const prompt = "JAM dispatch token. " + "Approved scope ".repeat(120);
	const wrap = (input: string, id = "a893") =>
		'\n\n<pasted_content id="a893">\n' +
		input +
		'\n</pasted_content id="' +
		id +
		'">\n';
	assert.equal(exactNativeTerminalSubmission(prompt, prompt), true);
	assert.equal(exactNativeTerminalSubmission(wrap(prompt), prompt), true);
	assert.equal(
		exactNativeTerminalSubmission(wrap(prompt, "f000"), prompt),
		false,
	);
	assert.equal(
		exactNativeTerminalSubmission(wrap(prompt.slice(0, -2)), prompt),
		false,
	);
	assert.equal(
		exactNativeTerminalSubmission(wrap(prompt) + "another turn", prompt),
		false,
	);
});

test("a native follow-up requires a submitted turn, successful dispatch, the original member and its delivered reply", async (t) => {
	const config = await mkdtemp(join(tmpdir(), "jam-roster-"));
	t.after(() => rm(config, { recursive: true, force: true }));
	const cwd = "/fixture/lead",
		session = "native-session",
		name = "manager",
		handle = "original-member",
		agentType = "test-manager";
	const lead = { sessionId: session, cwd, timestamp: "2026-11-18T16:55:50Z" };
	const member = {
		...lead,
		agentId: handle,
		timestamp: "2026-11-18T16:55:52Z",
	};
	const initial = {
		config,
		cwd,
		session,
		name,
		agentType,
		challenge: "original",
		expected: "original",
	};
	const team = "session-" + session.slice(0, 8);
	const prefix = join(config, "projects", "-fixture-lead", session);
	const memberDir = join(prefix, "subagents");
	await mkdir(memberDir, { recursive: true });
	await writeFile(
		join(memberDir, "agent-" + handle + ".meta.json"),
		JSON.stringify({
			name,
			teamName: team,
			taskKind: "in_process_teammate",
			customAgentType: agentType,
			spawnedAgentType: agentType,
		}),
	);
	const request = "Echo followup";
	const prompt = "Send this exact request to manager: " + request;
	const result = (id: string, success = true) => ({
		type: "tool_result",
		tool_use_id: id,
		content: [{ type: "text", text: JSON.stringify({ success }) }],
	});
	const send = (id: string, to: string, message: string) => ({
		type: "tool_use",
		name: "SendMessage",
		id,
		input: { to, message },
	});
	const envelope = (actor: string, message: string) =>
		'Another Claude session sent a message:\n<agent-message from="' +
		actor +
		'">\n' +
		message +
		"\n</agent-message>\n";
	const row = (author: typeof lead, type: string, content: unknown) => ({
		...author,
		type,
		message: { content },
	});
	const originalLead = [
		row(lead, "assistant", [
			{
				type: "tool_use",
				name: "Agent",
				id: "spawn",
				input: { name, subagent_type: agentType, prompt: "Echo original" },
			},
		]),
		row(lead, "user", [
			{
				type: "tool_result",
				tool_use_id: "spawn",
				content: "agent_id: " + handle,
			},
		]),
		row(lead, "user", envelope(name, "original")),
	];
	const originalMember = [
		row(member, "assistant", [send("reply-first", "main", "original")]),
	];
	const followupBody = "followup\nSecond work product";
	const submitted = row(lead, "user", prompt);
	const dispatch = row(lead, "assistant", [
		send("dispatch", "manager", request),
	]);
	const confirmed = row(lead, "user", [result("dispatch")]);
	const delivered = row(lead, "user", envelope(name, followupBody));
	const memberTurn = [
		row(
			member,
			"user",
			'<teammate-message teammate_id="team-lead" summary="Echo request">\n' +
				request +
				"\n</teammate-message>",
		),
		row(member, "assistant", [send("reply", "main", followupBody)]),
		row(member, "user", [result("reply")]),
	];
	const leadTurn = [submitted, dispatch, confirmed, delivered];
	const persist = async (nextLead: unknown[], nextMember: unknown[]) => {
		await Promise.all([
			writeFile(
				prefix + ".jsonl",
				[...originalLead, ...nextLead]
					.map((record) => JSON.stringify(record))
					.join("\n") + "\n",
			),
			writeFile(
				join(memberDir, "agent-" + handle + ".jsonl"),
				[...originalMember, ...nextMember]
					.map((record) => JSON.stringify(record))
					.join("\n") + "\n",
			),
		]);
	};
	const query = { initial, handle, prompt, request, challenge: "followup" };
	await persist(leadTurn, memberTurn);
	assert.deepEqual(await nativeFollowupReceipt(query), {
		handle,
		nativeMember: name + "@" + team,
		dispatchId: "dispatch",
		replyId: "reply",
		output: "Second work product",
	});
	const alternate =
		'Another Claude session sent a message:\n<teammate-message teammate_id="manager" color="blue" summary="completed">\n' +
		followupBody +
		"\n</teammate-message>";
	await persist(
		[...leadTurn.slice(0, 3), row(lead, "user", alternate)],
		memberTurn,
	);
	assert.equal(
		(await nativeFollowupReceipt(query))?.output,
		"Second work product",
	);
	await persist(
		[
			...leadTurn.slice(0, 3),
			row(
				lead,
				"user",
				alternate.replace('teammate_id="manager"', 'teammate_id="manager-2"'),
			),
		],
		memberTurn,
	);
	assert.equal(await nativeFollowupReceipt(query), undefined);
	await persist(
		[
			submitted,
			dispatch,
			confirmed,
			{ ...row(lead, "user", "Runtime system reminder"), isMeta: true },
			delivered,
		],
		memberTurn,
	);
	assert.equal(
		(await nativeFollowupReceipt(query))?.output,
		"Second work product",
	);
	assert.equal(
		await nativeFollowupReceipt({ ...query, handle: "different-member" }),
		undefined,
	);

	await persist(leadTurn.slice(1), memberTurn);
	assert.equal(await nativeFollowupReceipt(query), undefined);
	await persist([submitted, confirmed, dispatch, delivered], memberTurn);
	assert.equal(await nativeFollowupReceipt(query), undefined);
	await persist(
		[
			...leadTurn.slice(0, 3),
			row(lead, "user", envelope("different-manager", followupBody)),
		],
		memberTurn,
	);
	assert.equal(await nativeFollowupReceipt(query), undefined);
	await persist(
		leadTurn,
		memberTurn.map((record) => ({ ...record, agentId: "different-member" })),
	);
	assert.equal(await nativeFollowupReceipt(query), undefined);
	await persist(
		[
			submitted,
			dispatch,
			row(lead, "user", [result("dispatch", false)]),
			delivered,
		],
		memberTurn,
	);
	await assert.rejects(nativeFollowupReceipt(query), /did not succeed/);
	await persist(
		[
			submitted,
			dispatch,
			row(lead, "assistant", [send("duplicate", name, request)]),
			confirmed,
			delivered,
		],
		memberTurn,
	);
	await assert.rejects(nativeFollowupReceipt(query), /Ambiguous/);
	await persist(
		[
			...leadTurn,
			row(lead, "assistant", [
				{ type: "tool_use", name: "Agent", id: "extra-spawn" },
			]),
		],
		memberTurn,
	);
	await assert.rejects(nativeFollowupReceipt(query), /one native roster spawn/);
	await persist([...leadTurn, submitted], memberTurn);
	await assert.rejects(nativeFollowupReceipt(query), /Duplicate/);
	await persist(leadTurn, [
		...memberTurn,
		{ ...member, type: "assistant", message: { stop_reason: "refusal" } },
	]);
	await assert.rejects(nativeFollowupReceipt(query), /refused/);

	const originalTurn = [submitted, dispatch, confirmed];
	const subsequentTurn = row(lead, "user", "Work for a different manager.");
	const concurrentQuery = { ...query, allowLaterDelivery: true };
	const nativeDelivery = { ...delivered, isMeta: true };
	await persist([...originalTurn, subsequentTurn, delivered], memberTurn);
	assert.equal(await nativeFollowupReceipt(concurrentQuery), undefined);
	await persist([...originalTurn, subsequentTurn, nativeDelivery], memberTurn);
	assert.equal(await nativeFollowupReceipt(query), undefined);
	assert.equal(
		(await nativeFollowupReceipt(concurrentQuery))?.replyId,
		"reply",
	);
	const preview = envelope(
		name,
		JSON.stringify({
			type: "idle_notification",
			from: name,
			result: followupBody,
		}),
	);
	for (const nonDelivery of [
		envelope("different-manager", followupBody),
		envelope(name, followupBody + " "),
		preview,
	]) {
		await persist(
			[
				...originalTurn,
				subsequentTurn,
				{ ...row(lead, "user", nonDelivery), isMeta: true },
			],
			memberTurn,
		);
		assert.equal(await nativeFollowupReceipt(concurrentQuery), undefined);
	}
	await persist(
		[submitted, dispatch, subsequentTurn, confirmed, nativeDelivery],
		memberTurn,
	);
	assert.equal(await nativeFollowupReceipt(concurrentQuery), undefined);
	await persist(
		[...originalTurn, subsequentTurn, nativeDelivery, nativeDelivery],
		memberTurn,
	);
	await assert.rejects(nativeFollowupReceipt(concurrentQuery), /Ambiguous/);
	const leadRefusal = {
		...lead,
		type: "assistant",
		message: { stop_reason: "refusal" },
	};
	await persist(
		[...originalTurn, subsequentTurn, leadRefusal, nativeDelivery],
		memberTurn,
	);
	await assert.rejects(nativeFollowupReceipt(concurrentQuery), /refused/);
});
