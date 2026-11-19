import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverValidation } from "../scripts/macos/validation-recovery.mjs";
test("read-only recovery waits for its existing validation, then repeats at most once", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "jam-readonly-recovery-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "request.json"), "{}");
	const id = "00000000-0000-4000-8000-000000000001";
	let replayed = 0,
		stopped = 0;
	const owned = {
		inspect: async (name) => ({ running: true, owner: name }),
		stop: async () => {
			stopped++;
		},
		replay: async () => {
			replayed++;
		},
	};
	assert.equal(await recoverValidation(dir, id, owned), "waiting");
	assert.equal(replayed, 0);
	assert.equal(
		await recoverValidation(dir, id, { ...owned, now: Date.now() + 121000 }),
		"replayed",
	);
	assert.equal(stopped, 2);
	assert.equal(replayed, 1);
	await assert.rejects(
		recoverValidation(dir, id, { ...owned, inspect: async () => null }),
		/budget exhausted/,
	);
	assert.equal(replayed, 1);
});
test("read-only recovery never stops a container owned by another operation", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "jam-readonly-owner-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "request.json"), "{}");
	await assert.rejects(
		recoverValidation(dir, "00000000-0000-4000-8000-000000000001", {
			now: Date.now() + 121000,
			inspect: async () => ({ running: true, owner: "other" }),
			stop: async () => assert.fail("foreign stop"),
			replay: async () => assert.fail("duplicate replay"),
		}),
		/ownership/,
	);
});

test("a staged recovery intent consumes the replay budget after a second interruption", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "jam-readonly-intent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "request.json"), "{}");
	await writeFile(join(dir, "validation-recovery.json.tmp"), "{}");
	await assert.rejects(
		recoverValidation(dir, "00000000-0000-4000-8000-000000000001", {
			inspect: async () => null,
			stop: async () => assert.fail("stop"),
			replay: async () => assert.fail("duplicate replay"),
		}),
		/budget exhausted/,
	);
});
