import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { claimJson, readJson } from "./storage.js";
import type { TaskApproval } from "./task-approval.js";

const checks = {
	baseline:
		"Run the full configured static and unit checks on the frozen production baseline.",
	"assertion-red":
		"Edit only the approved test files. Run them with unchanged baseline production, passing static checks and failing on assertions of missing behavior.",
	"worker-green":
		"Run the full configured static and unit checks on the implementation and the same regression tests before implementation consultation.",
	"combined-green":
		"Validate the exact combined candidate with the configured static and unit suite.",
	"browser-sum":
		"Run the configured sum calculator Chromium smoke suite on the exact combined candidate.",
	"browser-calculator":
		"Run the configured calculator Chromium smoke suite on the exact combined candidate.",
	"browser-runningTotals": "Run the configured running-totals browser case.",
	"browser-clearTotals": "Run the configured Clear browser case.",
	"browser-dragons": "Run the configured dragons calculator browser case.",
	"browser-reset": "Run the configured reset browser case.",
	"browser-staticSvg": "Run the configured SVG browser case.",
	"deployed-svg":
		"After publication, run the configured deployed SVG acceptance.",
};
const required = [
	"baseline",
	"assertion-red",
	"worker-green",
	"combined-green",
] as const;
const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const check = z.enum(
	Object.keys(checks) as [keyof typeof checks, ...(keyof typeof checks)[]],
);
const recipeSchema = z
	.strictObject({
		version: z.literal(1),
		issue: z.int().positive(),
		recipe: z.enum(["node-strip", "typescript-build", "typescript-compiled"]),
		identity: hash,
		checks: z.array(check).min(4).max(12),
	})
	.refine(
		(value) =>
			new Set(value.checks).size === value.checks.length &&
			required.every((item) => value.checks.includes(item)),
		"Missing or repeated recipe checks",
	);
const contractSchema = z.strictObject({
	version: z.literal(1),
	approval: hash,
	base: z.string().regex(/^[a-f0-9]{40}$/),
	files: z.array(z.string()).min(1).max(32),
	tests: z.array(z.string()).min(1).max(32),
	recipe: recipeSchema,
});
const text = z.string().trim().min(1).max(1600);
const proposalSchema = z.strictObject({
	decision: z
		.string()
		.trim()
		.min(1)
		.max(600)
		.regex(/^[^\r\n]+$/),
	coverage: z
		.array(
			z.strictObject({
				requirement: text,
				checks: z.array(check).min(1).max(12),
			}),
		)
		.max(16),
	notes: z.array(text).max(12),
	unsupported: z
		.array(z.strictObject({ requirement: text, reason: text }))
		.max(6),
});

export type DevelopmentContract = z.infer<typeof contractSchema>;
export const isUnitTest = (path: string) =>
	/^(?:test|tests)\/.*\.test\.[cm]?[jt]s$/.test(path);
export function developmentContract(
	issue: number,
	approval: TaskApproval,
	base: string,
	files: string[],
	recipe: unknown,
): DevelopmentContract {
	const configured = recipeSchema.parse(recipe);
	const folder = configured.recipe === "node-strip" ? "tests/" : "test/";
	const contract = contractSchema.parse({
		version: 1,
		approval: digest(JSON.stringify(approval)),
		base,
		files,
		tests: files.filter((path) => isUnitTest(path) && path.startsWith(folder)),
		recipe: configured,
	});
	if (contract.recipe.issue !== issue)
		throw Error("Development recipe belongs to a different approved issue");
	return contract;
}

const optional = <T>(path: string) =>
	readJson<T>(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
const contractPath = (folder: string) =>
	join(folder, "architecture-contract.json");
export async function savedDevelopmentContract(folder: string) {
	const saved = await optional<unknown>(contractPath(folder));
	return saved === undefined ? undefined : contractSchema.parse(saved);
}
export async function pinDevelopmentContract(
	folder: string,
	contract: DevelopmentContract,
) {
	if (
		!(await claimJson(contractPath(folder), contract)) &&
		JSON.stringify(await savedDevelopmentContract(folder)) !==
			JSON.stringify(contract)
	)
		throw Error(
			"Development recipe or approval differs from the pinned specification contract",
		);
	return contract;
}

export const proposalInstructions =
	'Return only JSON {"decision":"one sentence under 200 characters","coverage":[{"requirement":"verbatim passage from approved issue title or body","checks":["actual check ID"]}],"notes":["short advisory design rationale or example"],"unsupported":[{"requirement":"verbatim approved passage","reason":"available recipe cannot prove this"}]}. JAM renders the procedure from the configured checks. Keep notes advisory. Never mandate a production stub or author new browser or deployment steps. If the approval explicitly requires unsupported evidence, report it in unsupported. Preserve the approved behavior and file scope.';

export class UnsupportedDevelopmentProof extends Error {}

function literal(value: string) {
	const length = Math.max(
		3,
		...(value.match(/`+/g) ?? []).map((run) => run.length + 1),
	);
	const fence = "`".repeat(length);
	return fence + "text\n" + value + "\n" + fence;
}
export function renderDevelopmentSpecification(
	contract: DevelopmentContract,
	approval: TaskApproval,
	raw: string,
) {
	if (contract.approval !== digest(JSON.stringify(approval)))
		throw Error("Specification approval differs from its pinned contract");
	const proposal = proposalSchema.parse(JSON.parse(raw));
	const approved = (excerpt: string) =>
		approval.title.includes(excerpt) || approval.body.includes(excerpt);
	if (
		[...proposal.coverage, ...proposal.unsupported].some(
			(entry) => !approved(entry.requirement),
		)
	)
		throw Error("Specification coverage must cite the approved task verbatim");
	if (
		proposal.coverage.some((entry) =>
			entry.checks.some((id) => !contract.recipe.checks.includes(id)),
		)
	)
		throw Error(
			"Specification refers to evidence outside the configured Development recipe",
		);
	if (proposal.unsupported.length)
		throw new UnsupportedDevelopmentProof(
			proposal.unsupported
				.map((entry) => entry.requirement + "\n" + entry.reason)
				.join("\n\n"),
		);
	const sections = [
		"## Approved task",
		literal(approval.title + "\n\n" + approval.body),
		"## Approved file scope",
		contract.files.map((path) => "- `" + path + "`").join("\n"),
		"## Required Development checks",
		contract.recipe.checks
			.map((id) => "- `" + id + "` " + checks[id])
			.join("\n"),
		"The pre-implementation regression may assert that a required new source file exists before attempting to load it. Static, type, import and environment errors remain gate failures. Production files are excluded from the RED edit.",
		"Approved RED paths: " +
			contract.tests.map((path) => "`" + path + "`").join(", ") +
			".",
		"Baseline `" +
			contract.base +
			"` and recipe `" +
			contract.recipe.identity +
			"`.",
		"## Coverage references",
		...proposal.coverage.map(
			(entry) =>
				literal(entry.requirement) +
				"\n" +
				entry.checks.map((id) => "`" + id + "`").join(" "),
		),
		"## Advisory design notes",
		literal([proposal.decision, ...proposal.notes].join("\n\n")),
	];
	const markdown = sections.join("\n\n") + "\n";
	if (Buffer.byteLength(markdown) > 65536)
		throw Error("Specification exceeds the attachment limit");
	return markdown;
}

interface ArchitectReceipt {
	output: string;
	dispatchIdentity?: string;
}
interface Render {
	version: 1;
	contract: string;
	source: string;
	dispatchIdentity: string;
	digest: string;
	output: string;
}
const renderPath = (folder: string) =>
	join(folder, "architect-specification.json");
const renderBinding = (
	contract: DevelopmentContract,
	receipt: ArchitectReceipt,
) => ({
	version: 1 as const,
	contract: digest(JSON.stringify(contract)),
	source: digest(receipt.output),
	dispatchIdentity: receipt.dispatchIdentity,
});
export async function prepareDevelopmentSpecification(
	folder: string,
	contract: DevelopmentContract,
	approval: TaskApproval,
	receipt: ArchitectReceipt,
) {
	const output = renderDevelopmentSpecification(
		contract,
		approval,
		receipt.output,
	);
	if (!receipt.dispatchIdentity)
		throw Error("Missing native specification dispatch identity");
	const render = {
		...renderBinding(contract, receipt),
		dispatchIdentity: receipt.dispatchIdentity,
		digest: digest(output),
		output,
	};
	if (
		!(await claimJson(renderPath(folder), render)) &&
		JSON.stringify(await readJson<Render>(renderPath(folder))) !==
			JSON.stringify(render)
	)
		throw Error("Specification render differs from the original attachment");
	return output;
}
export async function recordedArchitectSpecification(folder: string) {
	const receipt = await readJson<ArchitectReceipt>(
		join(folder, "architect.json"),
	);
	const contract = await savedDevelopmentContract(folder);
	if (!contract) return receipt;
	const render = await readJson<Render>(renderPath(folder));
	const { output, digest: expected, ...bound } = render;
	if (
		JSON.stringify(bound) !==
			JSON.stringify(renderBinding(contract, receipt)) ||
		expected !== digest(output)
	)
		throw Error("Saved specification failed receipt and recipe verification");
	return { ...receipt, output };
}
