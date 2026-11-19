import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyArtifactPages } from "../src/issue-artifact-recovery.js";
import { digestOf } from "../src/specification-upload.js";

test("recovery finds original Markdown on a later page and rejects missing or altered evidence", async () => {
	const name = "report.md";
	const body = "verified report\n";
	const expected = [{ number: 101, name, digest: digestOf(body) }];
	const row = {
		number: 101,
		name,
		body,
		type: "generic",
		html_url: "https://github.com/o/r/issues/24/artifacts/101",
		creator: { id: 42 },
	};
	const check = (pages: (typeof row)[][]) =>
		verifyArtifactPages(
			"o/r",
			24,
			42,
			expected,
			async (page) => pages[page - 1] ?? [],
		);
	await check([
		Array.from({ length: 100 }, (_, index) => ({ ...row, number: index + 1 })),
		[row],
	]);
	await assert.rejects(check([[]]), /missing/);
	await assert.rejects(check([[{ ...row, body: "altered" }]]), /differs/);
	await assert.rejects(check([[{ ...row, creator: { id: 12 } }]]), /differs/);
});
