import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	mailboxReceipt,
	nativeFollowupReceipt,
	stageRefused,
} from "../dist/src/native-teammate.js";

const state = await mkdtemp(join(tmpdir(), "jam-native-followup-"));
const cwd = join(state, "lead");
const home = join(state, "home");
const terminal = join(state, "terminal.log");
const config = await realpath(
	process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
);
const session = randomUUID();
const first = randomUUID();
const challenge = randomUUID();
const name = "manager";
const agentType = "jam-fixture-manager";
const initial = {
	config,
	cwd,
	session,
	name,
	agentType,
	challenge: first,
	expected: first,
};
const transcript = join(
	config,
	"projects",
	cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
	session + ".jsonl",
);
const request = "Echo " + challenge;
const prompt =
	"Using SendMessage to " +
	name +
	" only, send this request: " +
	request +
	". Wait for its reply. Do not spawn another agent.";
await Promise.all([mkdir(cwd), mkdir(home)]);
await Promise.all([
	symlink(config, join(home, ".claude")),
	writeFile(
		join(home, ".claude.json"),
		JSON.stringify({
			hasCompletedOnboarding: true,
			numStartups: 2,
			projects: { [cwd]: { hasTrustDialogAccepted: true } },
		}),
		{ mode: 0o600 },
	),
]);

const args = [
	"--session-id",
	session,
	"--model",
	"claude-opus-5-5",
	"--effort",
	"medium",
	"--setting-sources",
	"",
	"--settings",
	'{"disableAllHooks":true,"switchModelsOnFlag":false}',
	"--teammate-mode",
	"in-process",
	"--strict-mcp-config",
	"--tools",
	"Agent,SendMessage",
	"--allowedTools",
	"Agent,SendMessage",
	"--permission-mode",
	"dontAsk",
	"--disable-slash-commands",
	"--agents",
	JSON.stringify({
		[agentType]: {
			description: "Synthetic card task manager",
			tools: ["SendMessage"],
			prompt:
				"On each Echo request, SendMessage exactly the supplied token to main. Then remain available.",
		},
	}),
	"Spawn one named teammate " +
		name +
		" of type " +
		agentType +
		" with request Echo " +
		first +
		". When it replies, say READY and end your turn. Keep the teammate and team active. Do not spawn again.",
];
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const startedAt = Date.now();
const child = spawn(
	"script",
	["-qefc", "exec claude " + args.map(quote).join(" "), terminal],
	{
		cwd,
		stdio: ["pipe", "ignore", "ignore"],
		env: {
			...process.env,
			HOME: home,
			TERM: "xterm-256color",
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
		},
	},
);
const closed = new Promise((resolve) => child.once("close", resolve));
let launchError;
child.on("error", (error) => {
	launchError = error;
});
child.stdin.on("error", (error) => {
	launchError = error;
});
console.log(JSON.stringify({ state, session }));

async function text(path) {
	return readFile(path, "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return "";
	});
}
async function leadRows() {
	const raw = await text(transcript);
	return raw
		.slice(0, raw.lastIndexOf("\n") + 1)
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);
}
async function observe(phase, duration, check) {
	const deadline = Date.now() + duration;
	while (
		!launchError &&
		child.exitCode === null &&
		child.signalCode === null &&
		Date.now() < deadline
	) {
		if (await stageRefused(transcript, session, startedAt))
			throw Error("Native lead refused");
		const value = await check();
		if (value) return value;
		await delay(250);
	}
	throw launchError ?? Error("Timed out awaiting " + phase);
}
const write = (value) =>
	new Promise((resolve, reject) => {
		child.stdin.write(value, (error) => (error ? reject(error) : resolve()));
	});

try {
	const original = await observe(
		"first receipt and completed lead turn",
		80000,
		async () => {
			const lead = await leadRows();
			const index = lead.findIndex(
				(row) =>
					row.type === "user" &&
					typeof row.message?.content === "string" &&
					row.message.content.startsWith(
						"Another Claude session sent a message:\n",
					) &&
					row.message.content.includes("\n" + first + "\n"),
			);
			if (
				index < 0 ||
				!lead
					.slice(index + 1)
					.some(
						(row) =>
							row.type === "assistant" &&
							row.message?.stop_reason === "end_turn",
					)
			)
				return;
			return mailboxReceipt(initial);
		},
	);
	await delay(1000);
	await write(prompt);
	await observe("rendered follow-up before Enter", 5000, async () =>
		(await text(terminal)).includes(challenge),
	);
	await write("\r");
	await observe("second submitted user turn", 15000, async () =>
		(await leadRows()).some(
			(row) => row.type === "user" && row.message?.content === prompt,
		),
	);
	const receipt = await observe("verified native follow-up", 100000, () =>
		nativeFollowupReceipt({
			initial,
			handle: original.developer,
			prompt,
			request,
			challenge,
		}),
	);
	assert.equal(receipt.nativeMember, original.nativeMember);
	assert.equal(receipt.output, "");
	console.log(
		JSON.stringify({
			verified: true,
			member: receipt.nativeMember,
			dispatch: receipt.dispatchId,
			reply: receipt.replyId,
		}),
	);
} finally {
	child.kill("SIGTERM");
	await Promise.race([closed, delay(3000)]);
	if (child.exitCode === null && child.signalCode === null)
		child.kill("SIGKILL");
}
