import test from "node:test";
import assert from "node:assert/strict";
import {
	selectEnvironmentRecipe,
	signEnvironment,
	validEnvironmentSignature,
} from "../src/environment-wire.js";
import {
	runEnvironment,
	withEnvironmentAuthority,
	withoutEnvironmentAuthority,
} from "../src/environment-runner.js";

test("environment command requires management authority and signatures bind the full payload and direction", async () => {
	await assert.rejects(
		runEnvironment({
			serverId: "example",
			repoId: 1,
			environment: "staging",
			action: "deploy",
		}),
		/authenticated/,
	);
	await withEnvironmentAuthority("owner", () =>
		withoutEnvironmentAuthority(async () => {
			await Promise.resolve();
			await assert.rejects(
				runEnvironment({
					serverId: "example",
					repoId: 1,
					environment: "staging",
					action: "stop",
				}),
				/authenticated/,
			);
		}),
	);
	const body = JSON.stringify({
		repoId: 1,
		environment: "staging",
		action: "stop",
	});
	const signature = signEnvironment("operator", "request", body);
	assert.ok(validEnvironmentSignature("operator", "request", body, signature));
	assert.equal(
		validEnvironmentSignature("other", "request", body, signature),
		false,
	);
	assert.equal(
		validEnvironmentSignature("operator", "response", body, signature),
		false,
	);
	assert.equal(
		validEnvironmentSignature(
			"operator",
			"request",
			body.replace("staging", "other"),
			signature,
		),
		false,
	);
});

test("exact and templated recipes bind repository IDs and reject ambiguous instances", () => {
	const template = { repoId: 1, environmentPrefix: "preview-" },
		exact = { repoId: 1, environment: "preview-main" };
	assert.equal(
		selectEnvironmentRecipe([template, exact], 1, "preview-main"),
		exact,
	);
	assert.equal(selectEnvironmentRecipe([template], 1, "preview-new"), template);
	assert.equal(
		selectEnvironmentRecipe([template], 2, "preview-new"),
		undefined,
	);
	assert.equal(selectEnvironmentRecipe([template], 1, "preview-"), undefined);
	assert.throws(() =>
		selectEnvironmentRecipe(
			[template, { repoId: 1, environmentPrefix: "preview-pr-" }],
			1,
			"preview-pr-421",
		),
	);
	assert.throws(() =>
		selectEnvironmentRecipe([{ ...template, ...exact }], 1, "preview-new"),
	);
});

test("secret staging keeps bytes out of the signed environment command and requires authority", async (t) => {
	const { mkdtemp, readdir, readFile, writeFile, mkdir, rm, stat } =
		await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { randomUUID } = await import("node:crypto");
	const { runSecretOperation } = await import("../src/environment-runner.js");
	const root = await mkdtemp(join(tmpdir(), "jam-secret-wire-"));
	const prior = process.env.JAM_DEPLOY_EXCHANGE;
	process.env.JAM_DEPLOY_EXCHANGE = root;
	t.after(async () => {
		if (prior === undefined) delete process.env.JAM_DEPLOY_EXCHANGE;
		else process.env.JAM_DEPLOY_EXCHANGE = prior;
		await rm(root, { recursive: true, force: true });
	});
	const token = "a".repeat(64),
		canary = "ab-PRIVATE-canary-yz",
		requestId = randomUUID();
	const input = {
		serverId: randomUUID(),
		repoId: 1,
		environment: "preview",
		alias: "api-key",
		action: "secret-set" as const,
		requestId,
	};
	await assert.rejects(runSecretOperation(input, canary), /authenticated/);
	const pending = withEnvironmentAuthority(token, () =>
		runSecretOperation(input, canary),
	);
	let names: string[] = [];
	for (let i = 0; i < 100 && !names.length; i++) {
		names = (await readdir(root)).filter((name) => name.endsWith(".request"));
		if (!names.length) await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(names.length, 1);
	const outer = JSON.parse(await readFile(join(root, names[0]!), "utf8"));
	assert.equal(JSON.stringify(outer).includes(canary), false);
	assert.ok(
		validEnvironmentSignature(token, "request", outer.body, outer.signature),
	);
	const command = JSON.parse(outer.body);
	const blob = join(root, "secret-blobs", command.blobId);
	assert.equal(await readFile(blob, "utf8"), canary);
	assert.equal((await stat(blob)).mode & 0o777, 0o600);
	assert.equal(
		command.blobDigest,
		signEnvironment(token, "request", "jam-secret-blob-v1\0" + canary),
	);
	const body = JSON.stringify({
		id: command.id,
		ok: true,
		value: { alias: "api-key", requestId, updated: true },
	});
	await writeFile(
		join(root, command.id + ".response"),
		JSON.stringify({
			body,
			signature: signEnvironment(token, "response", body),
		}),
	);
	assert.deepEqual(await pending, {
		alias: "api-key",
		requestId,
		updated: true,
	});
});
