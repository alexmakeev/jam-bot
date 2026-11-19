import { recordProgress } from "./work-progress.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, readJson } from "./storage.js";
import {
	mailboxReceipt,
	nativeDispatchRefused,
	nativeWorkspaceEvidence,
	type NativeWorkspaceEvidence,
} from "./native-teammate.js";
import {
	runRoleStage,
	nativeRoleType,
	type RoleStage,
} from "./role-harness.js";
import { reportedRuntimeBlocker, RoleStageFailure } from "./role-failure.js";
import { nativeLeadOccupied } from "./native-lead.js";

export type ReviewRole = "consultant" | "integrator";
type Challenge = ReturnType<typeof randomUUID>;
type Receipt = Awaited<ReturnType<typeof runRoleStage>> & {
	workspaceEvidence?: NativeWorkspaceEvidence;
};
interface Attempt {
	challenge: Challenge;
	startedAt: number;
	endedAt?: number;
	completedAt?: number;
}
interface Checkpoint {
	session: string;
	issues: number[];
	revision: string;
	role: ReviewRole;
	input: string;
	attempts: Attempt[];
	receipt?: Receipt;
	failure?: string;
}
export interface MandatoryReview extends RoleStage {
	role: ReviewRole;
	issues: number[];
	revision: string;
	evidenceRound?: number;
}
const refusal = "The native model refused the mandatory review";
const unavailable =
	"The mandatory reviewer returned no verifiable result after bounded recovery";
const uncertain = "The previous mandatory reviewer may still be active";
export function reviewEvidenceSource(receipt: Receipt) {
	return receipt.workspaceEvidence?.sourceRead &&
		receipt.workspaceEvidence.specificationIndexRead
		? "The reviewer independently read the pinned source and specification index."
		: "The supplied review packet is the verified evidence. Independent workspace inspection remains unverified.";
}

export async function roleRefused(
	job: RoleStage,
	attempt: Pick<Attempt, "challenge" | "startedAt" | "completedAt">,
) {
	const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	const name = job.role + "-" + job.issue + "-" + attempt.challenge.slice(0, 6);
	const types = [
		nativeRoleType(job.role, job.workspaceManifest),
		...(job.workspaceManifest ? ["jam-" + job.role] : []),
	];
	for (const session of new Set(
		job.workspaceManifest ? [attempt.challenge, job.session] : [job.session],
	)) {
		for (const agentType of types) {
			if (
				await nativeDispatchRefused(
					{
						config,
						cwd: job.cwd,
						session,
						name,
						agentType,
						challenge: attempt.challenge,
					},
					attempt.startedAt,
					attempt.completedAt,
				)
			)
				return true;
		}
	}
	return false;
}

export async function observe(job: RoleStage, attempt: Attempt) {
	const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	if (await roleRefused(job, attempt)) return { refused: true };
	const name = job.role + "-" + job.issue + "-" + attempt.challenge.slice(0, 6);
	const sessions = [
		...new Set(
			job.workspaceManifest ? [attempt.challenge, job.session] : [job.session],
		),
	];
	const types = [
		nativeRoleType(job.role, job.workspaceManifest),
		...(job.workspaceManifest ? ["jam-" + job.role] : []),
	];
	const receipts = [];
	for (const session of sessions) {
		for (const agentType of types) {
			const receipt = await mailboxReceipt({
				config,
				cwd: job.cwd,
				session,
				name,
				challenge: attempt.challenge,
				agentType,
			});
			if (receipt) receipts.push(receipt);
		}
	}
	if (receipts.length > 1)
		throw Error(
			"Ambiguous original role capability identity requires reconciliation",
		);
	const receipt = receipts[0];
	if (receipt || attempt.endedAt) return { receipt };
	// A service restart can precede PTY teardown. Check identity before replacing this exact call.
	if (process.platform === "linux" && (await nativeLeadOccupied(job.state)))
		return { live: true };
	const pids = await readdir("/proc").catch(() => undefined);
	if (!pids) return { live: true };
	for (const pid of pids.filter((p) => /^\d+$/.test(p))) {
		const cmd = await readFile("/proc/" + pid + "/cmdline", "utf8").catch(
			(e: NodeJS.ErrnoException) => {
				if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(e.code ?? ""))
					return "";
				throw e;
			},
		);
		if (cmd.includes(attempt.challenge) && cmd.includes(name))
			return { live: true };
	}
	return {};
}

export async function mandatoryReview(
	job: MandatoryReview,
	escalate: (reason: string) => Promise<void>,
	deps: {
		run: typeof runRoleStage;
		observe: typeof observe;
		pause: () => Promise<void>;
		graceMs: number;
	} = {
		run: runRoleStage,
		observe,
		pause: () => delay(1000, undefined, { signal: job.signal }),
		graceMs: 30000,
	},
): Promise<Receipt> {
	if (
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.revision) ||
		!job.issues.includes(job.issue) ||
		job.issues.some((i) => !Number.isSafeInteger(i) || i < 1)
	)
		throw Error("Invalid mandatory review identity");
	if (
		job.evidenceRound !== undefined &&
		(!Number.isSafeInteger(job.evidenceRound) || job.evidenceRound < 0)
	)
		throw Error("Invalid review evidence round");
	const path = join(
		job.state,
		"mandatory-reviews",
		job.role +
			"-" +
			job.issues.join("-") +
			"-" +
			job.revision +
			(job.evidenceRound ? "-evidence-" + job.evidenceRound : "") +
			".json",
	);
	let saved = await readJson<Checkpoint>(path).catch(
		(e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		},
	);
	saved ??= {
		session: job.session,
		revision: job.revision,
		issues: job.issues,
		role: job.role,
		input: job.input,
		attempts: [],
	};
	if (saved.session !== job.session)
		throw Error("Mandatory review lead identity changed");
	const checkpoint = saved;
	const stop = async (reason: string): Promise<never> => {
		checkpoint.failure = reason;
		await atomicJson(path, checkpoint);
		for (const issue of job.issues)
			recordProgress(
				job.state,
				issue,
				"review-blocked:" + job.role + ":" + job.revision,
				"Mandatory " +
					job.role +
					" review of `" +
					job.revision +
					"` is blocked. " +
					reason +
					". JAM will deliver the evidence to the architect for diagnosis.",
			);
		await escalate(reason);
		throw Error(reason);
	};
	const done = async (receipt: Receipt) => {
		const attempt = checkpoint.attempts.at(-1);
		if (!attempt)
			return stop("The mandatory review receipt has no producing attempt");
		if (await roleRefused(job, attempt)) return stop(refusal);
		const blocker = reportedRuntimeBlocker(job.role, receipt.output);
		if (blocker) return stop(blocker.message);
		attempt.completedAt ??= Date.now();
		const workspaceEvidence =
			job.workspaceManifest && !receipt.workspaceEvidence
				? await nativeWorkspaceEvidence(
						job.state,
						job.issue,
						job.role,
						job.revision,
						{
							config:
								process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
							cwd: job.cwd,
							session: attempt.challenge,
							challenge: attempt.challenge,
							name:
								job.role +
								"-" +
								job.issue +
								"-" +
								attempt.challenge.slice(0, 6),
							agentType: nativeRoleType(job.role, job.workspaceManifest),
						},
						receipt.developer,
					).catch(() => undefined)
				: receipt.workspaceEvidence;
		checkpoint.receipt = workspaceEvidence
			? { ...receipt, workspaceEvidence }
			: receipt;
		await atomicJson(path, checkpoint);
		return checkpoint.receipt;
	};
	// Evidence repairs may repeat a completed review, but cannot supersede a refusal.
	for (let round = 0; round < (job.evidenceRound ?? 0); round++) {
		const earlier = await readJson<Checkpoint>(
			join(
				job.state,
				"mandatory-reviews",
				job.role +
					"-" +
					job.issues.join("-") +
					"-" +
					job.revision +
					(round ? "-evidence-" + round : "") +
					".json",
			),
		).catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		});
		if (earlier?.failure && /refus|declin|safety/i.test(earlier.failure))
			return stop(earlier.failure);
	}
	if (saved.failure) return stop(saved.failure);
	if (saved.receipt) return done(saved.receipt);
	for (;;) {
		job.signal.throwIfAborted();
		const last = saved.attempts.at(-1);
		if (last) {
			const until = Date.now() + deps.graceMs;
			for (;;) {
				let observation: Awaited<ReturnType<typeof observe>>;
				try {
					observation = await deps.observe(job, last);
				} catch (error) {
					if (
						error instanceof Error &&
						/declined or interrupted/.test(error.message)
					)
						return stop(
							"The harness declined or interrupted the mandatory review",
						);
					throw error;
				}
				if (observation.refused) return stop(refusal);
				if (observation.receipt) return done(observation.receipt);
				if (!observation.live) break;
				if (Date.now() >= until) return stop(uncertain);
				await deps.pause();
			}
		}
		if (saved.attempts.length >= 2) return stop(unavailable);
		const attempt = {
			challenge: randomUUID(),
			startedAt: Date.now(),
		} as Attempt;
		saved.attempts.push(attempt);
		await atomicJson(path, saved);
		if (saved.attempts.length > 1)
			for (const issue of job.issues)
				recordProgress(
					job.state,
					issue,
					"review-retry:" + job.role + ":" + job.revision,
					"JAM reconciled the original " +
						job.role +
						" assignment for `" +
						job.revision +
						"` and found no verified review. One bounded native review retry has been assigned.",
				);
		try {
			return await done(
				await deps.run({ ...job, input: saved.input }, attempt.challenge),
			);
		} catch (error) {
			if (job.signal.aborted || checkpoint.failure) throw error;
			const message = error instanceof Error ? error.message : "";
			if (error instanceof RoleStageFailure) return stop(error.message);
			if (/refused this stage/.test(message)) return stop(refusal);
			if (/declined or interrupted/.test(message))
				return stop("The harness declined or interrupted the mandatory review");
			if (
				!/receipt timed out|runtime exited before verified receipt/.test(
					message,
				)
			)
				return stop("The mandatory review could not establish a unique result");
			attempt.endedAt = Date.now();
			await atomicJson(path, saved);
		}
	}
}
