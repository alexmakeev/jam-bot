import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { envelope, recoveredIntake } from "../src/leo-intake.js";

test("only the exact scoped StructuredOutput result can recover interrupted intake", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jam-intake-structured-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const prior = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = root;
	t.after(() => {
		if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prior;
	});
	const cwd = "/fixture/lead",
		repository = "fixture/repo",
		lead = { id: "session", established: true };
	const event = {
		issue: 33,
		delivery: "approved-delivery",
		title: "Fixture",
		body: "",
	};
	const folder = join(root, "projects", "-fixture-lead");
	await mkdir(folder, { recursive: true });
	const scope = envelope(event, repository);
	const receipt = {
		issue: event.issue,
		delivery: event.delivery,
		disposition: "intake_received",
	};
	const user = { uuid: "input", type: "user", message: { content: scope } };
	const attachment = { uuid: "meta", type: "attachment", parentUuid: "input" };
	const assistant = {
		uuid: "acknowledgment",
		type: "assistant",
		parentUuid: "meta",
		message: {
			stop_reason: "tool_use",
			content: [
				{
					type: "tool_use",
					id: "call",
					name: "StructuredOutput",
					input: receipt,
				},
			],
		},
	};
	const result = {
		uuid: "result",
		type: "user",
		parentUuid: "acknowledgment",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: "call",
					content: "Structured output provided successfully",
				},
			],
		},
	};
	const persist = (rows: unknown[]) =>
		writeFile(
			join(folder, lead.id + ".jsonl"),
			rows
				.map((row) =>
					JSON.stringify({ sessionId: lead.id, ...(row as object) }),
				)
				.join("\n") + "\n",
		);
	const recover = () => recoveredIntake(event, lead, cwd, repository);
	await persist([user, attachment, assistant, result]);
	assert.deepEqual(await recover(), receipt);
	await persist([user, attachment, assistant]);
	assert.equal(await recover(), undefined);
	await persist([
		user,
		attachment,
		assistant,
		{ ...result, parentUuid: "other-turn" },
	]);
	assert.equal(await recover(), undefined);
	await persist([
		user,
		attachment,
		{ ...assistant, message: { ...assistant.message, stop_reason: "refusal" } },
		result,
	]);
	assert.equal(await recover(), undefined);
	await persist([
		{
			...user,
			message: {
				content: envelope({ ...event, delivery: "different" }, repository),
			},
		},
		attachment,
		assistant,
		result,
	]);
	assert.equal(await recover(), undefined);
});
