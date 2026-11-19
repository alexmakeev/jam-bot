import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyUnitEvents } from "../scripts/macos/unit-reporter.mjs";

const failure = (failureType, cause) => ({
	type: "test:fail",
	data: {
		name: "fixture",
		details: { error: { code: "ERR_TEST_FAILURE", failureType, cause } },
	},
});

test("only assertion leaf failures establish RED", () => {
	const assertion = failure("testCodeFailure", {
		code: "ERR_ASSERTION",
		message: "missing behavior",
	});
	assert.equal(
		classifyUnitEvents([assertion, failure("subtestsFailed")]).assertionOnly,
		true,
	);
	for (const other of [
		failure("testCodeFailure", { code: "ERR_MODULE_NOT_FOUND" }),
		failure("testTimeoutFailure"),
		failure("hookFailed", { code: "ERR_ASSERTION" }),
		failure("cancelledByParent"),
	]) {
		assert.equal(classifyUnitEvents([assertion, other]).assertionOnly, false);
	}
	assert.equal(
		classifyUnitEvents([failure("subtestsFailed")]).assertionOnly,
		false,
	);
	assert.equal(classifyUnitEvents([]).assertionOnly, false);
});

test("skipped, TODO and suite events do not count as executed passing tests", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "jam-unit-skipped-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "skipped.test.mjs");
	await writeFile(
		file,
		"import {describe,test} from 'node:test';describe('suite',()=>{test.skip('skipped',()=>{});test.todo('todo');});",
	);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"--test",
			"--test-reporter=" +
				fileURLToPath(
					new URL("../scripts/macos/unit-reporter.mjs", import.meta.url),
				),
			file,
		],
		{ env },
	);
	const receipt = JSON.parse(
		stdout
			.split("\n")
			.find((line) => line.startsWith("Unit results: "))
			.slice(14),
	);
	assert.equal(receipt.passed, 0);
	assert.equal(receipt.skipped, 1);
	assert.equal(receipt.todo, 1);
	assert.equal(receipt.suites, 1);
});

for (const mode of ["assertion", "import", "syntax"])
	test("real Node reporter " + mode + " evidence", async (t) => {
		const mixed = mode !== "assertion";
		const dir = await mkdtemp(join(tmpdir(), "jam-unit-report-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const assertion = join(dir, "assert.test.mjs");
		await writeFile(
			assertion,
			"import test from 'node:test';import assert from 'node:assert/strict';console.log('Unit results: fake output');test('missing feature',()=>assert.equal(1,2));",
		);
		const files = [assertion];
		if (mixed) {
			const broken = join(dir, "broken.test.mjs");
			await writeFile(
				broken,
				mode === "syntax" ? "const = ;" : "import './does-not-exist.mjs';",
			);
			files.push(broken);
		}
		let stdout = "";
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		try {
			await promisify(execFile)(
				process.execPath,
				[
					"--test",
					"--test-concurrency=1",
					"--test-reporter=" +
						fileURLToPath(
							new URL("../scripts/macos/unit-reporter.mjs", import.meta.url),
						),
					...files,
				],
				{ env },
			);
			assert.fail("Expected failed unit execution");
		} catch (error) {
			assert.equal(error.code, 1);
			stdout = error.stdout;
		}
		const lines = stdout
			.split("\n")
			.filter((line) => line.startsWith("Unit results: "));
		assert.equal(lines.length, 1);
		const result = JSON.parse(lines[0].slice("Unit results: ".length));
		assert.equal(result.assertionOnly, !mixed);
		assert.equal(result.assertions, 1);
		assert.equal(result.failed, mixed ? 2 : 1);
		assert.equal(stdout.includes("verified assertion-only RED"), !mixed);
	});
