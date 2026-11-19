import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagement } from "../src/management.js";
import {
	configureTopic,
	projectConnector,
	restoreManagedTopics,
	serverIdentity,
} from "../src/management-projects.js";
import { configuredTopics, type TopicRuntime } from "../src/topics.js";

test("an initially empty instance connects a single verified project across retries and restarts", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-manager-"));
	const routes = new Map<string, TopicRuntime>();
	t.after(async () => {
		for (const r of routes.values()) r.journal.db.close();
		await rm(state, { recursive: true, force: true });
	});
	assert.deepEqual(configuredTopics(state, {}), []);
	const id = serverIdentity(state);
	let started = 0;
	const connect = projectConnector(
		state,
		routes,
		() => {
			started++;
		},
		async (repository, installation) => ({
			repoId: 12,
			installation,
			repository,
		}),
	);
	const uri = "https://github.com/owner/example";
	const [first, second] = await Promise.all([
		connect(uri, 33),
		connect(uri, 33),
	]);
	assert.equal(first, second);
	assert.equal(started, 1);
	assert.match(first.topic.cwd, /projects\/owner\/example\/leo$/);
	const savedLead = first.journal.lead();
	const manager = await createManagement(state, routes);
	await assert.rejects(
		manager.invoke("configure_topic", {
			repoId: 12,
			serverId: "55990a47-83b2-4ef0-a4e9-7cbb4ce21a99",
			defaultClass: "consultation",
		}),
		/identity/,
	);
	await manager.invoke("configure_topic", {
		repoId: 12,
		serverId: id,
		defaultClass: "consultation",
	});
	configureTopic(state, first, "consultation", null);
	first.journal.db.close();
	routes.clear();
	await restoreManagedTopics(state, routes);
	assert.equal(serverIdentity(state), id);
	const restored = routes.get("33/12")!;
	assert.equal(restored.topic.defaultClass, "consultation");
	assert.deepEqual(restored.journal.lead(), savedLead);
	await assert.rejects(
		connect("https://github.com/owner/renamed", 33),
		/conflict/i,
	);
	await assert.rejects(connect("https://github.com/owner/..", 33));
	assert.equal(routes.size, 1);
});
