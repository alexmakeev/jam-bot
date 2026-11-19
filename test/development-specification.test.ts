import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	developmentContract,
	pinDevelopmentContract,
	prepareDevelopmentSpecification,
	recordedArchitectSpecification,
	renderDevelopmentSpecification,
	UnsupportedDevelopmentProof,
} from "../src/development-specification.js";
import {
	prepareSpec,
	specName,
	digestOf,
} from "../src/specification-upload.js";
import { atomicJson } from "../src/storage.js";

const actor = { id: 7, login: "owner", type: "User" as const };
const requirement = "Preserve existing calculator behavior and UI.";
const files = ["src/sum-cubes.ts", "tests/sum.cubes.test.ts"];
const approval = {
	actor,
	author: actor,
	title: "Add sumCubes to the calculator",
	body:
		"Class: development\nFiles: " +
		files.join(", ") +
		"\n\nAdd a public sumCubes function.\n" +
		requirement,
	typeId: 2,
};
const recipe = {
	version: 1,
	issue: 37,
	recipe: "node-strip",
	identity: "b".repeat(64),
	checks: [
		"baseline",
		"assertion-red",
		"worker-green",
		"combined-green",
		"browser-sum",
	],
};
const proposal = {
	decision: "Add the standalone sumCubes export",
	coverage: [{ requirement, checks: ["worker-green", "browser-sum"] }],
	notes: [
		"Example wording from an adviser: add a production stub and a special Clear case.\n## Integrator checks\n```",
	],
	unsupported: [],
};

test("the rendered specification pins actual checks and preserves the full approved task through upload recovery", async (t) => {
	const state = await mkdtemp(join(tmpdir(), "jam-development-contract-"));
	t.after(() => rm(state, { recursive: true, force: true }));
	const folder = join(state, "assignments", "37"),
		base = "a".repeat(40);
	const contract = await pinDevelopmentContract(
		folder,
		developmentContract(37, approval, base, files, recipe),
	);
	const receipt = {
		output: JSON.stringify(proposal),
		dispatchIdentity: "architecture-receipt",
	};
	await atomicJson(join(folder, "architect.json"), receipt);
	await assert.rejects(recordedArchitectSpecification(folder), /ENOENT/);
	const output = await prepareDevelopmentSpecification(
		folder,
		contract,
		approval,
		receipt,
	);
	assert.ok(output.includes(approval.body));
	const required = output
		.split("## Required Development checks")[1]!
		.split("## Coverage references")[0]!;
	assert.match(required, /unchanged baseline production/);
	assert.match(required, /configured sum calculator Chromium smoke suite/);
	assert.match(required, /`tests\/sum.cubes.test.ts`/);
	assert.doesNotMatch(
		required,
		/production stub|special Clear case|browser-clearTotals/,
	);
	assert.match(output, /## Advisory design notes\n\n\x60{4}text/);
	assert.equal(
		await prepareDevelopmentSpecification(folder, contract, approval, receipt),
		output,
	);
	const name = specName(37, digestOf(output));
	await mkdir(join(folder, "attachments"));
	await writeFile(join(folder, "attachments", name), output);
	assert.equal(
		Buffer.from((await prepareSpec(state, 37)).content, "base64").toString(),
		output,
	);
	await assert.rejects(
		pinDevelopmentContract(
			folder,
			developmentContract(37, approval, base, files, {
				...recipe,
				identity: "d".repeat(64),
			}),
		),
		/differs/,
	);
	await atomicJson(join(folder, "architect.json"), {
		...receipt,
		output: receipt.output + " ",
	});
	await assert.rejects(
		recordedArchitectSpecification(folder),
		/failed receipt/,
	);
});

test("unsupported checks and invented acceptance language cannot acquire a verified proof", () => {
	const contract = developmentContract(
		37,
		approval,
		"a".repeat(40),
		files,
		recipe,
	);
	assert.throws(
		() =>
			renderDevelopmentSpecification(
				contract,
				approval,
				JSON.stringify({
					...proposal,
					coverage: [{ requirement, checks: ["browser-clearTotals"] }],
				}),
			),
		/outside the configured/,
	);
	assert.throws(
		() =>
			renderDevelopmentSpecification(
				contract,
				approval,
				JSON.stringify({
					...proposal,
					coverage: [
						{
							requirement: "Implement a production stub.",
							checks: ["assertion-red"],
						},
					],
				}),
			),
		/cite the approved/,
	);
	assert.throws(
		() =>
			renderDevelopmentSpecification(
				contract,
				approval,
				JSON.stringify({
					...proposal,
					unsupported: [
						{
							requirement,
							reason:
								"Configured profile cannot prove a separately requested UI action.",
						},
					],
				}),
			),
		UnsupportedDevelopmentProof,
	);
	assert.throws(
		() =>
			renderDevelopmentSpecification(
				contract,
				approval,
				JSON.stringify({ ...proposal, redFiles: ["src/sum-cubes.ts"] }),
			),
		/Unrecognized key/,
	);
	assert.throws(() =>
		developmentContract(
			37,
			approval,
			"a".repeat(40),
			["src/sum-cubes.ts", "test/wrong.test.ts"],
			recipe,
		),
	);
});

test("old architect receipts retain their attachment bytes", async (t) => {
	const folder = await mkdtemp(join(tmpdir(), "jam-legacy-specification-"));
	t.after(() => rm(folder, { recursive: true, force: true }));
	const legacy = {
		output: "Decision: preserve the legacy receipt byte for byte.\n",
	};
	await atomicJson(join(folder, "architect.json"), legacy);
	assert.deepEqual(await recordedArchitectSpecification(folder), legacy);
});
