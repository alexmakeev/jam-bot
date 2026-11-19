import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	cp,
	symlink,
	stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { signEnvironment } from "../dist/src/environment-wire.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jam-secret-canary-"));
	const exchange = join(root, "exchange"),
		runtime = join(root, "runtime");
	await mkdir(exchange, { mode: 0o700 });
	await mkdir(join(exchange, "secret-blobs"), { mode: 0o700 });
	await mkdir(runtime);
	await cp(
		new URL("../scripts/macos/secret-store.mjs", import.meta.url),
		join(runtime, "secret-store.mjs"),
	);
	await cp(
		new URL("../dist/src/environment-wire.js", import.meta.url),
		join(runtime, "environment-wire.js"),
	);
	await writeFile(join(runtime, "package.json"), '{"type":"module"}');
	const module = await import(
		pathToFileURL(join(runtime, "secret-store.mjs")).href
	);
	const serverId = randomUUID(),
		token = "a".repeat(64),
		recipe = { repoId: 1, environment: "preview" };
	let db = new DatabaseSync(join(root, "secret-test.sqlite"));
	db.exec("PRAGMA synchronous=FULL");
	t.after(async () => {
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	const target = { serverId, repoId: 1, environment: "preview" };
	const run = (input) =>
		module.hostSecretOperation(input, {
			root,
			exchange,
			serverId,
			token,
			recipe,
			db,
		});
	async function write(value, extra = {}) {
		const blobId = randomUUID(),
			input = {
				...target,
				action: "secret-set",
				alias: "api-key",
				requestId: randomUUID(),
				blobId,
				blobDigest: signEnvironment(
					token,
					"request",
					"jam-secret-blob-v1\0" + value,
				),
				...extra,
			};
		await writeFile(join(exchange, "secret-blobs", blobId), value, {
			mode: 0o600,
		});
		return { input, run: () => run(input) };
	}
	return {
		root,
		exchange,
		target,
		token,
		recipe,
		module,
		run,
		write,
		reopen: () => {
			db.close();
			db = new DatabaseSync(join(root, "secret-test.sqlite"));
		},
		db: () => db,
	};
}

test("atomic set/replace and masked get/list preserve idempotency without raw journal values", async (t) => {
	const f = await fixture(t),
		canary = "ab-CANARY-not-returned-yz";
	const first = await f.write(canary);
	const ack = await first.run();
	assert.deepEqual(ack, {
		requestId: first.input.requestId,
		alias: "api-key",
		updated: true,
	});
	assert.deepEqual(
		await f.run({ ...f.target, action: "secret-get", alias: "api-key" }),
		{ secrets: [{ alias: "api-key", present: true, masked: "ab****yz" }] },
	);
	const replacement = await f.write("xy-another-secret-uv");
	await replacement.run();
	assert.deepEqual(await first.run(), ack); // lost-response retry does not overwrite the replacement
	assert.equal(
		(await f.run({ ...f.target, action: "secret-get" })).secrets[0].masked,
		"xy****uv",
	);
	const short = await f.write("1234", { alias: "short" });
	await short.run();
	assert.equal(
		(await f.run({ ...f.target, action: "secret-get", alias: "short" }))
			.secrets[0].masked,
		"****",
	);
	assert.deepEqual(
		await f.run({ ...f.target, action: "secret-get", alias: "absent" }),
		{ secrets: [{ alias: "absent", present: false, masked: null }] },
	);
	const rows = f.db().prepare("SELECT * FROM secret_writes").all();
	assert.equal(JSON.stringify(rows).includes(canary), false);
	assert.equal(
		(await readFile(join(f.root, "secret-test.sqlite"))).includes(
			Buffer.from(canary),
		),
		false,
	);
	const bad = await f.write("different", { requestId: first.input.requestId });
	await assert.rejects(bad.run, /conflicts/);
	const bindings = await f.module.managedSecretBindings(
		f.root,
		1,
		"preview",
		["api-key"],
		{},
	);
	assert.equal(
		await readFile(bindings["api-key"], "utf8"),
		"xy-another-secret-uv",
	);
	assert.equal((await stat(bindings["api-key"])).mode & 0o777, 0o600);
});

test("prepared writes recover after restart, while completed retries preserve newer values", async (t) => {
	const f = await fixture(t),
		job = await f.write("aa-restart-canary-zz");
	f.db().exec(
		"CREATE TABLE secret_writes(requestId TEXT PRIMARY KEY,target TEXT,digest TEXT,state TEXT,response TEXT)",
	);
	f.db()
		.prepare("INSERT INTO secret_writes VALUES(?,?,?,'prepared',NULL)")
		.run(job.input.requestId, "1/preview/api-key", job.input.blobDigest);
	f.reopen();
	await job.run();
	assert.equal(
		(await f.run({ ...f.target, action: "secret-get", alias: "api-key" }))
			.secrets[0].masked,
		"aa****zz",
	);
	await f.run(job.input);
	assert.equal(
		f.db().prepare("SELECT COUNT(*) n FROM secret_writes").get().n,
		1,
	);
});

test("concurrent replacements expose only complete values and cannot cross project or environment scope", async (t) => {
	const f = await fixture(t),
		a = await f.write("aa-" + "A".repeat(20000) + "-xx"),
		b = await f.write("bb-" + "B".repeat(20000) + "-yy");
	const seed = await f.write("initial-complete-value");
	await seed.run();
	const location = await f.module.managedSecretBindings(
		f.root,
		1,
		"preview",
		["api-key"],
		{},
	);
	const allowed = new Set([
		"initial-complete-value",
		"aa-" + "A".repeat(20000) + "-xx",
		"bb-" + "B".repeat(20000) + "-yy",
	]);
	await Promise.all([
		a.run(),
		b.run(),
		(async () => {
			for (let i = 0; i < 20; i++)
				assert.ok(allowed.has(await readFile(location["api-key"], "utf8")));
		})(),
	]);
	const binding = await f.module.managedSecretBindings(
		f.root,
		1,
		"preview",
		["api-key"],
		{},
	);
	const value = await readFile(binding["api-key"], "utf8");
	assert.ok(
		value === "aa-" + "A".repeat(20000) + "-xx" ||
			value === "bb-" + "B".repeat(20000) + "-yy",
	);
	await assert.rejects(
		f.run({ ...f.target, repoId: 2, action: "secret-get" }),
		/scope/,
	);
	await assert.rejects(
		f.run({ ...f.target, environment: "other", action: "secret-get" }),
		/scope/,
	);
	await assert.rejects(
		f.run({ ...f.target, alias: "../escape", action: "secret-get" }),
		/scope/,
	);
	const linked = await f.write("CANARY-link");
	await rm(join(f.exchange, "secret-blobs", linked.input.blobId));
	await symlink(
		binding["api-key"],
		join(f.exchange, "secret-blobs", linked.input.blobId),
	);
	await assert.rejects(
		linked.run,
		(error) => !String(error).includes("CANARY-link"),
	);
});

test("masking uses code points and fixed mask length", async (t) => {
	const { module } = await fixture(t);
	for (const value of ["a", "ab", "abc", "abcd", "🫙🍯🙂😀"])
		assert.equal(module.maskSecret(value), "****");
	assert.equal(module.maskSecret("ab-middle-yz"), "ab****yz");
	assert.equal(module.maskSecret("🍯🫙middle🙂😀"), "🍯🫙****🙂😀");
});

test("operator-provisioned aliases retain their files and bindings", async (t) => {
	const f = await fixture(t),
		source = join(f.root, "operator-key");
	await writeFile(source, "op-operator-fixture-er", { mode: 0o600 });
	f.recipe.secrets = { "operator-key": source };
	assert.deepEqual(
		await f.run({ ...f.target, action: "secret-get", alias: "operator-key" }),
		{ secrets: [{ alias: "operator-key", present: true, masked: "op****er" }] },
	);
	const write = await f.write("new-value", { alias: "operator-key" });
	await assert.rejects(write.run, /operator-managed/);
	assert.equal(await readFile(source, "utf8"), "op-operator-fixture-er");
	assert.deepEqual(
		await f.module.managedSecretBindings(
			f.root,
			1,
			"preview",
			["operator-key"],
			f.recipe.secrets,
		),
		{ "operator-key": source },
	);
});

test("a stale prepared operation cannot overwrite a newer completed replacement", async (t) => {
	const f = await fixture(t),
		old = await f.write("aa-old-pending-zz");
	f.db().exec(
		"CREATE TABLE secret_writes(requestId TEXT PRIMARY KEY,target TEXT,digest TEXT,state TEXT,response TEXT)",
	);
	f.db()
		.prepare("INSERT INTO secret_writes VALUES(?,?,?,'prepared',NULL)")
		.run(old.input.requestId, "1/preview/api-key", old.input.blobDigest);
	const newer = await f.write("bb-new-value-yy");
	await newer.run();
	f.reopen();
	await assert.rejects(old.run, /superseded/);
	assert.equal(
		(await f.run({ ...f.target, action: "secret-get", alias: "api-key" }))
			.secrets[0].masked,
		"bb****yy",
	);
});
