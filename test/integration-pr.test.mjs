import test from "node:test";
import assert from "node:assert/strict";
import {
	prepareIntegrationPr,
	verifyIntegrationPr,
	confirmIntegrationPublication,
} from "../scripts/macos/integration-pr.mjs";
const revision = "a".repeat(40);
const record = {
	number: 7,
	head: { sha: revision },
	base: { ref: "dev", repo: { full_name: "o/r" } },
	state: "open",
};
test("first publication requires an existing dev identity before any remote effects", async () => {
	const unexpected = async () =>
		assert.fail(
			"Publication attempted a remote effect without an existing dev",
		);
	await assert.rejects(
		prepareIntegrationPr({
			repo: "o/r",
			revision,
			expected: "",
			cards: [{ issue: 1 }],
			git: unexpected,
			api: unexpected,
		}),
		/requires an existing dev branch/,
	);
});
test("recovery reuses the existing immutable branch and PR without another write", async () => {
	const writes = [];
	const pr = await prepareIntegrationPr({
		repo: "o/r",
		revision,
		expected: "b".repeat(40),
		cards: [{ issue: 1 }],
		git: async (args) => {
			assert.equal(args[0], "ls-remote");
			return revision + "\trefs/heads/jam/integration-" + revision;
		},
		api: async (path, method) => {
			if (method) writes.push(method);
			return [record];
		},
	});
	assert.equal(pr.number, 7);
	assert.deepEqual(writes, []);
});
test("closure evidence requires an actually merged PR for the exact candidate", async () => {
	await assert.rejects(
		verifyIntegrationPr(
			"o/r",
			7,
			revision,
			async () => ({ ...record, merged: false }),
			{ pause: async () => {} },
		),
		/reconciliation/,
	);
	await assert.rejects(
		verifyIntegrationPr("o/r", 7, revision, async () => ({
			...record,
			merged: true,
			head: { sha: "c".repeat(40) },
		})),
		/reconciliation/,
	);
	assert.equal(
		(
			await verifyIntegrationPr("o/r", 7, revision, async () => ({
				...record,
				merged: true,
				html_url: "https://example.test/pr",
			}))
		).sha,
		revision,
	);
});
test("GitHub merge convergence is bounded and performs reads only", async () => {
	let reads = 0,
		pauses = 0;
	const result = await verifyIntegrationPr(
		"o/r",
		7,
		revision,
		async (path, method) => {
			assert.equal(method, undefined);
			return { ...record, merged: ++reads === 3 };
		},
		{
			pause: async () => {
				pauses++;
			},
		},
	);
	assert.equal(result.sha, revision);
	assert.equal(reads, 3);
	assert.equal(pauses, 2);
});
test("publication recovery independently observes merged PR and exact dev without writes", async () => {
	const paths = [];
	const result = await confirmIntegrationPublication(
		"o/r",
		revision,
		async (path, method) => {
			assert.equal(method, undefined);
			paths.push(path);
			if (path.endsWith("/git/ref/heads/dev"))
				return { object: { sha: revision } };
			if (path.includes("/pulls?")) return [{ number: 7 }];
			return { ...record, merged: true };
		},
	);
	assert.equal(result.sha, revision);
	assert.equal(paths.length, 3);
	await assert.rejects(
		confirmIntegrationPublication("o/r", revision, async () => ({
			object: { sha: "b".repeat(40) },
		})),
		/reconciliation/,
	);
});
test("publication recovery verifies the exact merged PR after dev advances", async () => {
	const head = "b".repeat(40);
	const read = async (path, method) => {
		assert.equal(method, undefined);
		if (path.endsWith("/git/ref/heads/dev")) return { object: { sha: head } };
		if (path.endsWith("/compare/" + revision + "..." + head))
			return { status: "ahead", merge_base_commit: { sha: revision } };
		if (path.includes("/pulls?")) return [{ number: 7 }];
		return { ...record, merged: true };
	};
	assert.equal(
		(await confirmIntegrationPublication("o/r", revision, read)).number,
		7,
	);
	await assert.rejects(
		confirmIntegrationPublication("o/r", revision, async (path, method) =>
			path.includes("/compare/")
				? { status: "diverged", merge_base_commit: { sha: "c".repeat(40) } }
				: read(path, method),
		),
		/reconciliation/,
	);
});
