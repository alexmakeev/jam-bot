import { z } from "zod";
export const developmentEvidenceVersion = "development-static-v1";
export const developmentToolVersions = {
	typescript: "7.0.2",
	"@biomejs/biome": "2.3.8",
	"@babel/parser": "7.28.5",
	"@types/node": "22.20.5",
	parse5: "7.2.1",
	postcss: "8.5.6",
};
const identity = z.string().regex(/^[a-f0-9]{40}$/);
const executionSchema = z.strictObject({
	stage: z.enum(["test-red", "test-head", "test", "publish"]),
	tree: identity,
	productionRevision: identity,
	testRevision: identity,
});
const staticChecks = [
	"toolchain",
	"generated-code-comments",
	"lint",
	"format",
	"types",
];
const count = z.int().nonnegative();
const unitSchema = z
	.strictObject({
		version: z.literal("unit-assertions-v2"),
		passed: count,
		failed: count,
		assertions: count,
		aggregates: count,
		skipped: count,
		todo: count,
		suites: count,
		assertionOnly: z.boolean(),
		incomplete: z.boolean().optional(),
		failures: z
			.array(
				z.strictObject({
					name: z.string().max(160),
					assertion: z.boolean(),
					code: z.string().optional(),
					failureType: z.string().optional(),
					message: z.string().max(400),
				}),
			)
			.max(20),
	})
	.refine(
		(value) =>
			value.assertions <= value.failed &&
			value.failures.length === Math.min(value.failed, 20) &&
			value.assertionOnly ===
				(value.failed > 0 &&
					value.assertions === value.failed &&
					value.incomplete !== true),
		"Inconsistent unit evidence",
	);
function one(log: string, prefix: string) {
	const rows = log.split("\n").filter((line) => line.startsWith(prefix));
	if (rows.length !== 1)
		throw Error("Expected one trusted " + prefix.trim() + " receipt");
	return JSON.parse(rows[0]!.slice(prefix.length));
}
export function requireStaticQuality(log: string, revision: string) {
	const receipt = one(log, "Quality results: ");
	executionSchema.parse(receipt.execution);
	if (
		receipt.version !== developmentEvidenceVersion ||
		receipt.revision !== revision ||
		receipt.passing !== true ||
		!Array.isArray(receipt.checks) ||
		receipt.checks.length !== staticChecks.length ||
		staticChecks.some(
			(name) =>
				receipt.checks.filter(
					(check: { name: string; status: string }) =>
						check.name === name && check.status === "passed",
				).length !== 1,
		)
	)
		throw Error("Missing successful static checks on the exact revision");
	const toolchain = receipt.checks.find(
		(check: { name: string }) => check.name === "toolchain",
	).detail;
	if (
		!toolchain ||
		Object.entries(developmentToolVersions).some(
			([tool, version]) => toolchain[tool] !== version,
		)
	)
		throw Error("Quality receipt has a missing or different pinned toolchain");
	return receipt;
}
export function redStaticCorrections(
	log: string,
	revision: string,
	expected: { productionRevision: string; tree: string },
) {
	if (
		!log.startsWith("Profile broker: Validation failed for ") ||
		log.split("\n").some((line) => line.startsWith("Unit results: "))
	)
		return;
	try {
		const receipt = one(log, "Quality results: ");
		const execution = executionSchema.parse(receipt.execution);
		if (
			receipt.version !== developmentEvidenceVersion ||
			receipt.revision !== revision ||
			receipt.passing !== false ||
			execution.stage !== "test-red" ||
			execution.productionRevision !== expected.productionRevision ||
			execution.testRevision !== revision ||
			execution.tree !== expected.tree ||
			!Array.isArray(receipt.checks) ||
			receipt.checks.length !== staticChecks.length
		)
			return;
		const checks = staticChecks.map((name) =>
			receipt.checks.filter((check: { name: string }) => check.name === name),
		);
		if (
			checks.some(
				(group) =>
					group.length !== 1 || !["passed", "failed"].includes(group[0].status),
			)
		)
			return;
		const toolchain = checks[0]?.[0];
		if (
			toolchain?.status !== "passed" ||
			Object.entries(developmentToolVersions).some(
				([tool, version]) => toolchain.detail?.[tool] !== version,
			)
		)
			return;
		const failures = checks.flat().filter((check) => check.status === "failed");
		if (
			failures.length &&
			failures.every(
				(check) => typeof check.detail === "string" && check.detail.trim(),
			)
		)
			return failures
				.map((check) => check.name + "\n" + check.detail.slice(0, 6000))
				.join("\n\n");
	} catch {
		return;
	}
}
export function requireAssertionRed(
	log: string,
	revision: string,
	expected: { productionRevision: string; tree: string },
) {
	const quality = requireStaticQuality(log, revision);
	const execution = executionSchema.parse(quality.execution);
	if (
		execution.stage !== "test-red" ||
		execution.productionRevision !== expected.productionRevision ||
		execution.testRevision !== revision ||
		execution.tree !== expected.tree
	)
		throw Error(
			"RED execution does not match baseline production, candidate tests and exact composite tree",
		);
	const receipt = unitSchema.parse(one(log, "Unit results: "));
	if (
		receipt.assertionOnly !== true ||
		receipt.failed < 1 ||
		receipt.incomplete === true
	)
		throw Error("RED requires complete assertion-only unit failure evidence");
	return receipt;
}
export function requireGreenQuality(
	log: string,
	revision: string,
	expectedTree?: string,
) {
	const quality = requireStaticQuality(log, revision);
	const execution = executionSchema.parse(quality.execution);
	if (
		execution.stage === "test-red" ||
		execution.productionRevision !== revision ||
		execution.testRevision !== revision ||
		(expectedTree !== undefined && execution.tree !== expectedTree)
	)
		throw Error("GREEN execution does not match the exact candidate tree");
	const receipt = unitSchema.parse(one(log, "Unit results: "));
	if (
		receipt.passed < 1 ||
		receipt.failed !== 0 ||
		receipt.aggregates !== 0 ||
		receipt.incomplete === true
	)
		throw Error("GREEN requires complete passing unit execution evidence");
	return receipt;
}
