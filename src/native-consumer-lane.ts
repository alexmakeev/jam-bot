import type { WorkerScheduling } from "./developer-profile.js";
import type { Intake } from "./intake-journal.js";
import { nativeLeadOccupied } from "./native-lead.js";
import {
	recoverPersistentDispatch,
	type PersistentNativeLead,
} from "./native-persistent-lead.js";
import {
	NativeRoleDeferred,
	NativeWorkerWaits,
	type NativeWorkerIntent,
} from "./native-worker-wait.js";
import { observe } from "./review-supervisor.js";
import { runRoleStage } from "./role-harness.js";
import { observeTopicStep } from "./run-observations.js";
import { approvalFromEvent } from "./task-approval.js";
import type { TopicRuntime } from "./topics.js";
import { fingerprint } from "./work-progress.js";
import { loadWorkspace } from "./workspace-binding.js";

export interface NativeConsumerTransport {
	start: () => Promise<Pick<PersistentNativeLead, "startRole" | "close">>;
	recover?: typeof recoverPersistentDispatch;
	occupied?: typeof nativeLeadOccupied;
}

export class NativeConsumerLane {
	private readonly waits: NativeWorkerWaits;
	private readonly recover: typeof recoverPersistentDispatch;
	private readonly occupied: typeof nativeLeadOccupied;
	private pending?: {
		intent: NativeWorkerIntent;
		settled: boolean;
		error?: unknown;
		completion: Promise<void>;
	};

	constructor(
		private readonly runtime: TopicRuntime,
		private readonly transport: NativeConsumerTransport,
	) {
		this.waits = new NativeWorkerWaits(runtime.journal.db);
		this.recover = transport.recover ?? recoverPersistentDispatch;
		this.occupied = transport.occupied ?? nativeLeadOccupied;
	}

	private approval(task: Intake) {
		const { repoId, installation } = this.runtime.topic;
		return fingerprint(
			JSON.stringify([repoId, installation, approvalFromEvent(task)]),
		);
	}

	stage(task: Intake, files: string[]): WorkerScheduling["nativeStage"] {
		if (!files.length) return;
		return {
			run: async (job, challenge) => {
				if (job.role !== "developer" || !job.workspaceManifest)
					return runRoleStage(job, challenge);
				if (!challenge) throw Error("Native stage was not checkpointed");
				const workspace = await loadWorkspace(job.workspaceManifest);
				const intent: NativeWorkerIntent = {
					delivery: task.delivery,
					issue: task.issue,
					role: job.role,
					challenge,
					inputDigest: fingerprint(
						JSON.stringify([job.input, job.workspaceManifest]),
					),
					approvalDigest: this.approval(task),
					revision: workspace.identity.revision,
					files,
				};
				const previous = this.waits
					.waiting()
					.find((row) => row.intent.delivery === task.delivery);
				if (previous) this.waits.finishEffect(previous.intent);
				throw new NativeRoleDeferred(intent, job);
			},
			recover: async (
				job,
				attempt: Parameters<typeof observe>[1] & {
					nativeDeferred?: NativeWorkerIntent;
				},
			) => {
				const intent = attempt.nativeDeferred;
				if (!intent) return observe(job, attempt);
				if (
					intent.delivery !== task.delivery ||
					intent.approvalDigest !== this.approval(task)
				)
					throw Error(
						"Native recovery differs from the current authorized work card",
					);
				const result = await this.recover(
					this.runtime.state,
					task.issue,
					attempt.challenge,
					intent,
				);
				return result?.receipt ? { receipt: result.receipt } : {};
			},
		};
	}

	park(
		task: Intake,
		deferred: NativeRoleDeferred,
		authorize: () => Promise<void>,
	) {
		const { intent, job } = deferred;
		if (
			this.pending ||
			!job ||
			intent.delivery !== task.delivery ||
			intent.approvalDigest !== this.approval(task)
		)
			throw Error("Native stage has no fresh single-card launch authority");
		this.waits.park(intent);
		const pending: NonNullable<NativeConsumerLane["pending"]> = {
			intent,
			settled: false,
			completion: Promise.resolve()
				.then(() =>
					observeTopicStep(
						this.runtime.state,
						intent.issue,
						"worker",
						async () => {
							const lead = await observeTopicStep(
								this.runtime.state,
								intent.issue,
								"native-startup",
								this.transport.start,
								undefined,
								(error) =>
									error instanceof Error &&
									error.message ===
										"Native authentication_failed in this generation"
										? "auth-failed"
										: "error",
							);
							try {
								const completion = await observeTopicStep(
									this.runtime.state,
									intent.issue,
									"native-ack",
									async () => {
										const dispatched = await lead.startRole(
											job,
											intent,
											authorize,
										);
										await dispatched.acknowledgement;
										return { original: dispatched.completion };
									},
								);
								await observeTopicStep(
									this.runtime.state,
									intent.issue,
									"native-receipt",
									() => completion.original,
								);
							} catch (error) {
								await lead.close().catch(() => undefined);
								throw error;
							}
							await lead.close();
						},
					),
				)
				.catch((error) => {
					pending.error = error;
				})
				.finally(() => {
					pending.settled = true;
				}),
		};
		this.pending = pending;
	}

	busy() {
		return Boolean(this.pending && !this.pending.settled);
	}

	async harvest() {
		const { journal, state } = this.runtime;
		const [row] = this.waits.waiting();
		if (!row || row.state === "running" || this.busy()) return;
		const pending = this.pending;
		this.pending = undefined;
		const { intent } = row;
		if (pending && pending.intent.delivery !== intent.delivery)
			throw Error("Native wait lost its original delivery");
		if (!pending && (await this.occupied(state))) return;
		if (row.ready) {
			if (row.state === "pending") this.waits.reconcileParkedStage(intent);
			return;
		}
		const task = journal.workerTask(intent.delivery);
		let result: Awaited<ReturnType<typeof recoverPersistentDispatch>>;
		try {
			if (pending?.error) throw pending.error;
			if (
				!task ||
				task.issue !== intent.issue ||
				this.approval(task) !== intent.approvalDigest
			)
				throw Error(
					"Native worker is no longer bound to the original approval",
				);
			result = await this.recover(
				state,
				intent.issue,
				intent.challenge,
				intent,
			);
		} catch (error) {
			const reason =
				error instanceof Error && /refused|refusal/i.test(error.message)
					? "Original native dispatch refused; preserve the refusal and request review."
					: "Original native dispatch requires reconciliation before work can resume.";
			this.waits.freeze(intent, reason);
			return;
		}
		if (!result?.receipt || !task) {
			this.waits.freeze(
				intent,
				"Original native dispatch has no verified receipt. Review the original evidence.",
			);
			return;
		}
		if (row.state === "pending" && !this.waits.reconcileParkedStage(intent))
			return;
		this.waits.recordVerifiedReply(intent);
	}

	resume() {
		const row = this.waits.waiting().find((candidate) => candidate.ready);
		if (!row) return;
		const task = this.runtime.journal.workerTask(row.intent.delivery);
		if (!task || this.approval(task) !== row.intent.approvalDigest)
			throw Error("Native worker is no longer bound to the original approval");
		return this.waits.resume(row.intent) ? task : undefined;
	}

	finish(task: Intake) {
		const previous = this.waits
			.waiting()
			.find((row) => row.intent.delivery === task.delivery);
		if (previous) this.waits.finishEffect(previous.intent);
	}

	async settle() {
		await this.pending?.completion;
	}
}
