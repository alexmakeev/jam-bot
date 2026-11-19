import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/intake-journal.js";
import { environmentOperations } from "../src/management-environments.js";
import { topicKey, type TopicRuntime } from "../src/topics.js";

const serverId = "c95032b1-d049-46cd-8884-a0a6ccce744a";
const sha = "a".repeat(40);

test("management environments isolate projects, retain settings across reopening and enforce typed host inputs", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "jam-env-mgmt-"));
	const routes = new Map<string, TopicRuntime>();
	function open(id: number) {
		const topic = {
			repoId: id,
			repository: "owner/project-" + id,
			installation: 19,
			cwd: dir,
		};
		routes.set(topicKey(19, id), {
			topic,
			state: join(dir, String(id)),
			journal: new Journal(join(dir, id + ".sqlite")),
		});
	}
	open(1);
	open(2);
	t.after(() => {
		for (const route of routes.values()) route.journal.db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const calls: unknown[] = [];
	let approved: string | undefined;
	const api = environmentOperations(
		dir,
		routes,
		serverId,
		async (req) => {
			calls.push(req);
			return {
				environment: req.environment,
				running: req.action !== "stop",
				healthy: req.action !== "stop",
				revision: req.revision ?? null,
				image: null,
			};
		},
		async (_route, id, statement) => {
			if (id !== 76 || statement !== approved) throw Error("Invalid approval");
		},
	);
	async function invoke(name: string, input: Record<string, unknown> = {}) {
		const op = api.find((o) => o.name === "environment_" + name)!;
		return op.output.parse(
			await op.run(op.input.parse({ serverId, repoId: 1, ...input })),
		);
	}
	const stage = {
		environment: "preview",
		tier: "staging",
		settings: {
			logLevel: "warn",
			secretRefs: ["database"],
			endpoint: { address: "127.0.0.1", port: 18221 },
			appVariables: { APP_MODE: "demo" },
		},
	};
	assert.deepEqual(await invoke("upsert", stage), stage);
	const races = await Promise.allSettled([
		invoke("upsert", { ...stage, environment: "racing", tier: "stable" }),
		invoke("upsert", { ...stage, environment: "racing", tier: "staging" }),
	]);
	assert.equal(
		races.filter((result) => result.status === "fulfilled").length,
		1,
	);
	await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			invoke("upsert", {
				...stage,
				environment: "parallel",
				settings: { appVariables: { APP_VERSION: String(index) } },
			}),
		),
	);
	assert.equal(
		(await invoke("get", { environment: "parallel" })).tier,
		"staging",
	);
	routes.get(topicKey(19, 1))!.journal.db.close();
	open(1);
	assert.deepEqual(await invoke("get", { environment: "preview" }), stage);
	assert.deepEqual(await invoke("list", { repoId: 2 }), { environments: [] });
	await assert.rejects(invoke("get", { repoId: 999, environment: "preview" }));
	await assert.rejects(
		invoke("upsert", {
			...stage,
			serverId: "66266cb8-6c8c-4d22-8ac8-14cc9f643d74",
		}),
	);
	await assert.rejects(invoke("upsert", { ...stage, tier: "development" }));
	for (const unsafe of [
		{ DOCKER_HOST: "tcp://example" },
		{ logLevel: "x", secretRefs: [] },
		{ secretRefs: ["../../credentials"] },
		{ secretRefs: ["db", "db"] },
		{ appVariables: { APP_API_KEY: "private" } },
		{ appVariables: { DOCKER_HOST: "env" } },
		{ appVariables: { APP_MODE: "$PATH" } },
		{ endpoint: { address: "0.0.0.0", port: 18221 } },
	]) {
		await assert.rejects(invoke("upsert", { ...stage, settings: unsafe }));
	}
	await assert.rejects(
		invoke("deploy", { environment: "preview", revision: "main" }),
	);
	await invoke("deploy", { environment: "preview", revision: sha });
	assert.deepEqual(calls[0], {
		serverId,
		repoId: 1,
		environment: "preview",
		tier: "staging",
		action: "deploy",
		revision: sha,
		config: { LOG_LEVEL: "warn" },
		secretRefs: ["database"],
		appVariables: { APP_MODE: "demo" },
		endpoint: { address: "127.0.0.1", port: 18221 },
	});
	await invoke("status", { environment: "preview" });
	await invoke("stop", { environment: "preview" });
	await invoke("upsert", { environment: "live", tier: "stable", settings: {} });
	const stable = { environment: "live", revision: sha };
	await assert.rejects(invoke("deploy", stable));
	await assert.rejects(invoke("deploy", { ...stable, approvalCommentId: 76 }));
	approved =
		"Approve JAM-Bot stable deployment of owner/project-1 to live on " +
		serverId +
		" at " +
		sha +
		".";
	await invoke("deploy", { ...stable, approvalCommentId: 76 });
	await assert.rejects(
		invoke("deploy", {
			...stable,
			revision: "b".repeat(40),
			approvalCommentId: 76,
		}),
	);
	assert.equal(calls.length, 4);
});

test("binding an existing local preview needs a matching host observation and preserves host ownership", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "jam-bind-"));
	const topic = {
		repoId: 1,
		repository: "example/project",
		installation: 9,
		cwd: dir,
	};
	const route = {
		topic,
		state: dir,
		journal: new Journal(join(dir, "journal.sqlite")),
	};
	t.after(() => {
		route.journal.db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const routes = new Map([[topicKey(9, 1), route]]);
	let registered = false;
	const actions: string[] = [];
	function ops() {
		return environmentOperations(dir, routes, serverId, async (input) => {
			actions.push(input.action);
			return {
				environment: "preview",
				running: true,
				healthy: true,
				revision: null,
				image: null,
				...(registered
					? {
							observation: {
								web: { url: "http://127.0.0.1:5173/", status: 200 },
							},
						}
					: {}),
			};
		});
	}
	const run = async (name: string, fields: object = {}) => {
		const op = ops().find((op) => op.name === "environment_" + name)!;
		return op.output.parse(
			await op.run(
				op.input.parse({
					serverId,
					repoId: 1,
					environment: "preview",
					...fields,
				}),
			),
		);
	};
	const definition = {
		tier: "development",
		binding: "existing-local",
		settings: {},
	};
	await assert.rejects(run("upsert", definition), /did not verify/);
	registered = true;
	await run("upsert", definition);
	await run("upsert", definition);
	assert.equal((await run("get")).binding, "existing-local");
	await run("status");
	await assert.rejects(
		run("upsert", {
			...definition,
			settings: { endpoint: { address: "127.0.0.1", port: 9999 } },
		}),
	);
	await assert.rejects(
		run("upsert", { tier: "development", settings: {} }),
		/binding mode/,
	);
	await assert.rejects(run("deploy", { revision: sha }), /own launcher/);
	await assert.rejects(run("stop"), /own launcher/);
	assert.deepEqual(actions, ["status", "status", "status", "status"]);
});
