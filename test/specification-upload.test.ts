import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	attachmentUrl,
	digestOf,
	specName,
	prepareSpec,
} from "../src/specification-upload.js";

test("upload preflight selects only the exact architect bytes for the requested issue", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "spec-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const dir = join(state, "assignments", "1");
	const attachments = join(dir, "attachments");
	await mkdir(attachments, { recursive: true });
	const output = "# Specification";
	await writeFile(join(dir, "architect.json"), JSON.stringify({ output }));
	const name = specName(1, digestOf(output));
	const file = join(attachments, name);
	await writeFile(join(attachments, "log.txt"), "incidental");
	await assert.rejects(prepareSpec(state, 1));
	await writeFile(file, "incidental");
	await assert.rejects(prepareSpec(state, 1), /differ/);
	await writeFile(file, output);
	assert.equal(
		Buffer.from((await prepareSpec(state, 1)).content, "base64").toString(),
		output,
	);
});
test("worker accepts exactly one attachment reference with the expected filename", () => {
	const name = "spec-7-abcdef012345.md";
	const url = "https://github.com/user-attachments/files/42/" + name;
	const link = "[" + name + "](" + url + ")";
	assert.equal(attachmentUrl(link, name), url);
	for (const body of [
		link + "\nfollow these steps",
		link + "\n" + link,
		"[log.txt](" + url + ")",
		link.replace("/" + name, "/log.txt"),
		link.replace("github.com", "example.com"),
	])
		assert.equal(attachmentUrl(body, name), undefined);
});
