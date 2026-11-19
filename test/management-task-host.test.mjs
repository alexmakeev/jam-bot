import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { hostTask } from "../scripts/macos/management-task-host.mjs";

test("human Task creation reconciles an ambiguous post and refuses scope reuse or a changed identity", async () => {
	const db = new DatabaseSync(":memory:"),
		serverId = randomUUID(),
		requestId = randomUUID();
	const input = {
		action: "task_create",
		serverId,
		repoId: 1,
		repository: "owner/sample",
		title: "Consult",
		body: "Class: consultation\nReview scope.",
		requestId,
	};
	let posts = 0,
		saved;
	const user = { id: 42, type: "User", login: "owner" };
	const config = async () =>
		JSON.stringify({ repoIds: [1], userId: 42, login: "owner" });
	const api = async (path, payload) => {
		if (path === "user") return user;
		if (path === "repos/owner/sample")
			return { id: 1, full_name: "owner/sample" };
		if (path.endsWith("/permission")) return { user, permission: "write" };
		if (payload) {
			posts++;
			saved = { number: 7, user, ...payload, type: { name: "Task" } };
			throw Error("Response lost");
		}
		if (path.includes("/issues?")) return [saved];
		throw Error("Unexpected path");
	};
	const run = (changes = {}) =>
		hostTask({ ...input, ...changes }, serverId, db, config, api);
	await assert.rejects(run(), /Response lost/);
	assert.equal((await run()).issue, 7);
	assert.equal((await run()).issue, 7);
	await assert.rejects(run({ title: "Changed" }), /Different Task scope/);
	user.id = 77;
	await assert.rejects(run(), /binding or write/);
	assert.equal(posts, 1);
	db.close();
});
