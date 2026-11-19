import test from "node:test";
import assert from "node:assert/strict";
import {
	redStaticCorrections,
	requireAssertionRed,
	requireStaticQuality,
	requireGreenQuality,
	developmentToolVersions,
} from "../src/development-evidence.js";
const revision = "a".repeat(40);
const expected = { productionRevision: "b".repeat(40), tree: "c".repeat(40) };
const execution = {
	stage: "test-red",
	tree: expected.tree,
	productionRevision: expected.productionRevision,
	testRevision: revision,
};
const quality = {
	execution,
	version: "development-static-v1",
	revision,
	passing: true,
	checks: [
		"toolchain",
		"generated-code-comments",
		"lint",
		"format",
		"types",
	].map((name) => ({
		name,
		status: "passed",
		...(name === "toolchain" ? { detail: developmentToolVersions } : {}),
	})),
};
const unit = {
	version: "unit-assertions-v2",
	passed: 0,
	failed: 1,
	assertions: 1,
	aggregates: 0,
	skipped: 0,
	todo: 0,
	suites: 0,
	assertionOnly: true,
	failures: [
		{
			name: "regression",
			assertion: true,
			code: "ERR_ASSERTION",
			message: "missing behavior",
		},
	],
};
const log = (q = quality, u = unit) =>
	"Quality results: " +
	JSON.stringify(q) +
	"\nUnit results: " +
	JSON.stringify(u);
test("only a pinned test-only static diagnostic can request a bounded RED correction", () => {
	const diagnostic = {
		...quality,
		passing: false,
		checks: quality.checks.map((check) =>
			check.name === "types"
				? {
						...check,
						status: "failed",
						detail:
							"tests/new.test.ts(7,58): error TS1470: import.meta is not allowed in CommonJS output.",
					}
				: check,
		),
	};
	const failure = (receipt: unknown) =>
		"Profile broker: Validation failed for node-strip\nQuality results: " +
		JSON.stringify(receipt);
	assert.match(
		redStaticCorrections(failure(diagnostic), revision, expected) ?? "",
		/TS1470/,
	);
	assert.throws(() =>
		requireAssertionRed(failure(diagnostic), revision, expected),
	);
	assert.equal(
		redStaticCorrections(failure(diagnostic), revision, {
			...expected,
			tree: "d".repeat(40),
		}),
		undefined,
	);
	assert.equal(
		redStaticCorrections(
			failure({
				...diagnostic,
				checks: diagnostic.checks.map((check) =>
					check.name === "toolchain" ? { ...check, status: "failed" } : check,
				),
			}),
			revision,
			expected,
		),
		undefined,
	);
	assert.equal(
		redStaticCorrections(
			failure(diagnostic) + "\nUnit results: " + JSON.stringify(unit),
			revision,
			expected,
		),
		undefined,
	);
	assert.equal(
		redStaticCorrections("A native provider refused", revision, expected),
		undefined,
	);
});
test("development evidence requires exact-revision quality and unambiguous assertion-only RED", () => {
	assert.equal(requireAssertionRed(log(), revision, expected).failed, 1);
	assert.throws(() => requireStaticQuality(log(), "b".repeat(40)));
	assert.throws(() =>
		requireAssertionRed(
			log(quality, { ...unit, failed: 2 }),
			revision,
			expected,
		),
	);
	assert.throws(() =>
		requireAssertionRed(
			log() + "\nUnit results: " + JSON.stringify(unit),
			revision,
			expected,
		),
	);
	assert.throws(() =>
		requireAssertionRed(
			log({ ...quality, checks: quality.checks.slice(1) }),
			revision,
			expected,
		),
	);
	assert.throws(() =>
		requireAssertionRed(
			"AssertionError ERR_ASSERTION\n# fail 1",
			revision,
			expected,
		),
	);
	assert.throws(() =>
		requireStaticQuality(
			log({
				...quality,
				checks: quality.checks.map((check) => ({
					...check,
					detail: undefined,
				})),
			}),
			revision,
		),
	);
});

test("GREEN requires unit execution as well as static success", () => {
	const greenQuality = {
		...quality,
		execution: {
			stage: "test-head",
			tree: expected.tree,
			productionRevision: revision,
			testRevision: revision,
		},
	};
	const green = {
		...unit,
		passed: 3,
		failed: 0,
		assertions: 0,
		aggregates: 0,
		assertionOnly: false,
		failures: [],
	};
	assert.equal(
		requireGreenQuality(log(greenQuality, green), revision, expected.tree)
			.passed,
		3,
	);
	assert.throws(() => requireGreenQuality(log(), revision));
	assert.throws(() =>
		requireGreenQuality(
			"Quality results: " + JSON.stringify(quality),
			revision,
		),
	);
	assert.throws(() =>
		requireGreenQuality(log(greenQuality, { ...green, passed: 0 }), revision),
	);
});

test("RED binds complete execution identity rather than the candidate label alone", () => {
	for (const execution of [
		undefined,
		{ ...quality.execution, stage: "test-head" },
		{ ...quality.execution, tree: "d".repeat(40) },
		{ ...quality.execution, productionRevision: revision },
		{ ...quality.execution, testRevision: "d".repeat(40) },
	]) {
		assert.throws(() =>
			requireAssertionRed(
				log({ ...quality, execution } as typeof quality),
				revision,
				expected,
			),
		);
	}
});

test("GREEN rejects a composite RED tree and mismatched candidate identities", () => {
	const green = {
		...unit,
		passed: 1,
		failed: 0,
		assertions: 0,
		aggregates: 0,
		assertionOnly: false,
		failures: [],
	};
	assert.throws(() => requireGreenQuality(log(quality, green), revision));
	const q = {
		...quality,
		execution: {
			...quality.execution,
			stage: "test-head",
			productionRevision: revision,
		},
	};
	assert.throws(() =>
		requireGreenQuality(log(q, green), revision, "d".repeat(40)),
	);
	assert.throws(() =>
		requireGreenQuality(
			log(
				{ ...q, execution: { ...q.execution, testRevision: "d".repeat(40) } },
				green,
			),
			revision,
		),
	);
	assert.throws(() =>
		requireGreenQuality(
			log(q, { ...green, passed: 0, skipped: 4, todo: 2, suites: 1 }),
			revision,
		),
	);
});
