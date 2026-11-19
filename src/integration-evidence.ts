import { createHash } from "node:crypto";
import { reviewPacket } from "./external-advice.js";

interface RunEvidence {
	sha?: string;
	log?: string;
}
interface Advice {
	provider: string;
	model?: string;
	status: string;
	text: string;
}
export interface IntegrationEvidenceCard {
	issue: number;
	sha: string;
	task: string;
	spec: string;
	workerValidation: RunEvidence;
	baseline: RunEvidence;
	red: RunEvidence;
	implementationConsultations: { inputDigest: string; advice: Advice[] };
	workerReview: { output: string };
	artifacts?: { name: string; url: string; digest: string }[];
}
const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");
function testReceipt(run: RunEvidence) {
	const log = run.log ?? "";
	const metadata = log
		.split("\n")
		.filter((line) =>
			/^(?:Quality (?:gate|results): |Unit results: |Recipe:|Image:|Build:|Command:|Exit code:|Revision:|Production baseline:|# (?:tests|pass|fail) |.*AssertionError|.*ERR_ASSERTION)/.test(
				line,
			),
		);
	return {
		revision: run.sha,
		logDigest: digest(log),
		executionSummary: metadata,
		fullLog:
			"Retained in the original issue worker artifact and local checkpoint",
	};
}

// Full specifications and logs stay in durable issue artifacts. The reviewer gets
// per-card identities and verified execution receipts without repeated TAP output.
export function integrationEvidence(
	shared: Record<string, string>,
	cards: IntegrationEvidenceCard[],
	limit = 75000,
) {
	const fields = { ...shared };
	for (const card of cards) {
		const key = "issue-" + card.issue;
		fields[key + "-identity"] = JSON.stringify({
			issue: card.issue,
			revision: card.sha,
			requirements: card.task,
			specificationDigest: digest(card.spec),
			artifacts: card.artifacts ?? [],
		});
		fields[key + "-specification"] = card.spec;
		fields[key + "-tests"] = JSON.stringify({
			baseline: testReceipt(card.baseline),
			red: testReceipt(card.red),
			green: testReceipt(card.workerValidation),
		});
		fields[key + "-reviews"] = JSON.stringify({
			inputDigest: card.implementationConsultations.inputDigest,
			advisers: card.implementationConsultations.advice.map((a) => ({
				provider: a.provider,
				model: a.model,
				status: a.status,
				summary: a.text.slice(0, 1200),
				fullDigest: digest(a.text),
			})),
			workerVerdict: card.workerReview.output.slice(0, 3000),
			workerVerdictDigest: digest(card.workerReview.output),
		});
	}
	return reviewPacket(fields, limit);
}
