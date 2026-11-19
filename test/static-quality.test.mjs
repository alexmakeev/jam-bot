import test from "node:test";
import assert from "node:assert/strict";
import {
	staticQuality,
	introducedComments,
	toolContract,
	gateVersion,
} from "../scripts/macos/static-quality.mjs";

const input = {
	recipe: "node-strip",
	sha: "a".repeat(40),
	execution: {
		stage: "test-head",
		tree: "b".repeat(40),
		productionRevision: "a".repeat(40),
		testRevision: "a".repeat(40),
	},
	files: ["tests/a.test.ts"],
	changed: [],
	baseline: {},
};
const fake = () => ({
	version: async (tool) => toolContract[tool],
	parse: () => ({ comments: [] }),
	source: async () => "",
	run: async () => "",
});

test("quality receipts bind all fixed checks to the exact revision", async () => {
	const calls = [];
	const tools = {
		...fake(),
		run: async (tool, args) => {
			calls.push({ tool, args });
			return "ok";
		},
	};
	const result = await staticQuality(input, tools);
	assert.equal(result.passing, true);
	assert.equal(result.version, gateVersion);
	assert.equal(result.revision, input.sha);
	assert.deepEqual(result.execution, input.execution);
	assert.deepEqual(
		result.checks.map((check) => check.name),
		["toolchain", "generated-code-comments", "lint", "format", "types"],
	);
	assert.deepEqual(
		calls.map((call) => call.tool),
		["biome", "biome", "tsc"],
	);
	assert(calls[0].args.includes("--config-path=/tmp/jam-quality"));
	assert(calls[2].args.includes("--checkJs"));
	assert(!calls.some((call) => call.args.includes("npm")));
});

for (const failing of ["lint", "format", "types"])
	test(failing + " failure blocks the stronger gate", async () => {
		const tools = {
			...fake(),
			run: async (tool, args) => {
				if ((tool === "tsc" ? "types" : args[0]) === failing)
					throw Error("fixture failure");
				return "ok";
			},
		};
		const result = await staticQuality(input, tools);
		assert.equal(result.passing, false);
		assert.equal(
			result.checks.find((check) => check.name === failing).status,
			"failed",
		);
	});

test("missing or mismatched trusted tools remain unavailable and never execute candidates", async () => {
	for (const version of [undefined, "0.0.0"]) {
		let ran = false;
		const result = await staticQuality(input, {
			...fake(),
			version: async () => version,
			run: async () => {
				ran = true;
			},
		});
		assert.equal(result.passing, false);
		assert.equal(ran, false);
		assert(result.checks.every((check) => check.status === "unavailable"));
	}
});

test("unsupported changed languages block comment coverage explicitly", async () => {
	const result = await staticQuality(
		{ ...input, changed: ["web/index.html"] },
		fake(),
	);
	assert.equal(result.passing, false);
	assert.equal(
		result.checks.find((check) => check.name === "generated-code-comments")
			.status,
		"unavailable",
	);
});

test("comment comparison uses parser ranges, preserves old tokens, and rejects added copies", () => {
	const old = 'const url="https://example.com"; /* keep */';
	const added = old + " /* keep */";
	const parse = (text) => ({
		comments:
			text === old
				? [{ start: 32, end: 42 }]
				: [
						{ start: 32, end: 42 },
						{ start: 43, end: 53 },
					],
	});
	assert.deepEqual(introducedComments(parse, "src/a.ts", old, old), []);
	assert.equal(introducedComments(parse, "src/a.ts", old, added).length, 1);
});

test("typescript build uses a fixed no-emit compiler invocation", async () => {
	const calls = [];
	await staticQuality(
		{ ...input, recipe: "typescript-build" },
		{
			...fake(),
			run: async (tool, args) => {
				calls.push([tool, args]);
				return "";
			},
		},
	);
	assert.deepEqual(calls.at(-1), [
		"tsc",
		["-p", "tsconfig.json", "--noEmit", "--incremental", "false"],
	]);
});
