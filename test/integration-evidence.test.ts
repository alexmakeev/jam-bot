import test from "node:test";
import assert from "node:assert/strict";
import {
	integrationEvidence,
	type IntegrationEvidenceCard,
} from "../src/integration-evidence.js";

function card(issue: number): IntegrationEvidenceCard {
	const sha = String(issue).padStart(40, "0");
	const green =
		"Recipe: typescript-build\nImage: sha256:pinned\nCommand: node --test\nExit code: 0\nRevision: " +
		sha +
		"\n" +
		"verbose TAP output\n".repeat(2000) +
		"# tests 20\n# pass 20\n# fail 0\n";
	return {
		issue,
		sha,
		task: "Approved change " + issue,
		spec: "# Spec " + issue + "\nAcceptance criteria for this card.",
		baseline: { sha: "a".repeat(40), log: green },
		red: {
			sha: "b".repeat(40),
			log: "Recipe: typescript-build\nExit code: 1\nAssertionError: missing behavior\n# tests 20\n# pass 19\n# fail 1\n",
		},
		workerValidation: { sha, log: green },
		implementationConsultations: {
			inputDigest: "d".repeat(64),
			advice: [
				{
					provider: "codex",
					model: "configured-model",
					status: "ok",
					text: "Reviewed implementation and test coverage.",
				},
				{
					provider: "antigravity",
					status: "ok",
					text: "Reviewed implementation and test coverage.",
				},
			],
		},
		workerReview: { output: "PASS\nAccepted." },
		artifacts: [
			{
				name: "tests.md",
				url: "https://github.com/o/r/issues/" + issue + "/artifacts/1",
				digest: "e".repeat(64),
			},
		],
	};
}

test("three full worker logs fit the integration stage while preserving every card receipt", () => {
	const cards = [card(1), card(2), card(3)];
	assert.ok(cards.reduce((n, c) => n + JSON.stringify(c).length, 0) > 80000);
	const packet = integrationEvidence(
		{
			candidate: "exact combined revision",
			combinedChecks: "Browser and unit checks passed",
		},
		cards,
	);
	assert.ok(Buffer.byteLength(packet) < 75000);
	const fields = JSON.parse(packet);
	for (const c of cards) {
		assert.equal(
			JSON.parse(fields["issue-" + c.issue + "-identity"]).revision,
			c.sha,
		);
		const tests = JSON.parse(fields["issue-" + c.issue + "-tests"]);
		assert.ok(tests.green.executionSummary.includes("# fail 0"));
		assert.ok(tests.red.executionSummary.includes("# fail 1"));
		assert.match(tests.green.logDigest, /^[a-f0-9]{64}$/);
		assert.equal(
			JSON.parse(fields["issue-" + c.issue + "-reviews"]).advisers.length,
			2,
		);
	}
});

test("ten-card packet retains the shared checks and verified artifact references", () => {
	const packet = integrationEvidence(
		{ combinedChecks: "Shared exact-candidate acceptance passed" },
		Array.from({ length: 10 }, (_, i) => card(i + 1)),
	);
	assert.ok(Buffer.byteLength(packet) <= 75000);
	const fields = JSON.parse(packet);
	assert.equal(
		fields.combinedChecks,
		"Shared exact-candidate acceptance passed",
	);
	for (let i = 1; i <= 10; i++)
		assert.equal(
			JSON.parse(fields["issue-" + i + "-identity"]).artifacts[0].url,
			"https://github.com/o/r/issues/" + i + "/artifacts/1",
		);
});
