import { parseTaskCard } from "./profile-card.js";
import { refreshProjectValues } from "./project-values.js";
import { DecisionPending, pauseDecision } from "./material-decision.js";
import {
	readdir,
	readFile,
	readlink,
	realpath,
	mkdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
	consultationReady,
	ProfileLookupUnavailable,
	PublisherSeedUnavailable,
} from "./profile-checkout.js";
import {
	prepareReviewNotices,
	migrateReviewNotices,
	deliverReviewNotice,
} from "./review-escalation.js";
import {
	beginDashboard,
	fingerprint,
	recordProgress,
	publishTimeline,
	pendingProgress,
} from "./work-progress.js";
import { Journal } from "./intake-journal.js";
import { withoutEnvironmentAuthority } from "./environment-runner.js";
import { TaskAdmission } from "./task-admission.js";
import {
	approvalFromEvent,
	TaskWithdrawn,
	validateTaskApproval,
} from "./task-approval.js";
import { notifyLeo, recoveredIntake } from "./leo-intake.js";
import {
	dispatchApprovedWorker,
	WORKER_ACCEPTANCE_BODY,
} from "./approved-worker.js";
import { deliverConnectionNotice } from "./connection-notice.js";
import { configuredTopics, openTopics, type TopicRuntime } from "./topics.js";
import { IntegrationQueue, type ReadyBranch } from "./integration-queue.js";
import { BranchValidation } from "./branch-validation.js";
import {
	integrateReady,
	validateReviewedHead,
	prefillDevelopmentTasks,
	IntegrationLaneYield,
	NativeLaneYield,
	type AdviceLane,
} from "./developer-profile.js";
import { ConsultationDeferred } from "./external-advice.js";
import { configuredManagement } from "./management-transport.js";
import { InstallationGrants } from "./installation-grants.js";
import {
	pausedRepositories,
	projectConnector,
	restoreManagedTopics,
} from "./management-projects.js";
import { createManagement } from "./management.js";
import { webhook } from "./webhook.js";
import {
	DependencyHold,
	DependencyTaskWithdrawn,
	usesDependencies,
	verifyDependencies,
} from "./github-dependencies.js";
import { nativeLeadOccupied } from "./native-lead.js";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error("Missing " + name);
	return value;
}
async function requireOwnerLock(path: string) {
	for (const fd of await readdir("/proc/self/fd")) {
		const target = await readlink("/proc/self/fd/" + fd).catch(() => null);
		if (
			target === path &&
			/FLOCK\s+ADVISORY\s+WRITE/.test(
				await readFile("/proc/self/fdinfo/" + fd, "utf8"),
			)
		)
			return;
	}
	throw new Error("Start the service under flock -n -F " + path);
}
export async function consume(
	{ journal, topic, state }: TopicRuntime,
	signal: AbortSignal,
) {
	const integrations = new IntegrationQueue(journal.db);
	const validations = new BranchValidation(journal.db);
	validations.recover();
	const runtime = { journal, topic, state };
	const dependencyAware = usesDependencies(topic);
	const overlap =
		dependencyAware &&
		(process.env.JAM_DEVELOPMENT_ADVICE_OVERLAP_REPOSITORIES ?? "")
			.split(",")
			.map((name) => name.trim())
			.includes(topic.repository);
	const eligibleIntegration = (epoch: number) => (head: ReadyBranch) =>
		!integrations.dependencyHeld(head, epoch);
	const beforeSpecification = dependencyAware
		? () => {
				const { active, ready } = integrations.snapshot();
				if (
					active ||
					ready.some(eligibleIntegration(journal.dependencyEpoch()))
				)
					throw new IntegrationLaneYield();
			}
		: undefined;
	const filesOf = (
		task: ReturnType<typeof journal.workerCandidates>[number],
	) => {
		const card = parseTaskCard(
			task.title,
			task.body,
			task.kind,
			topic.defaultClass,
		);
		return card?.kind === "development" ? card.files : [];
	};
	const compatible = (files: string[], occupied: string[]) =>
		files.length > 0 && !files.some((path) => occupied.includes(path));
	const readyAdvice = async () => {
		for (const row of journal.activeAdviceWaits())
			if (!overlap || (await consultationReady(state, row.wait))) return row;
	};
	const adviceLane = (
		task: ReturnType<typeof journal.workerCandidates>[number],
	): AdviceLane | undefined => {
		const files = filesOf(task);
		if (!overlap || !files.length) return;
		const approval = fingerprint(JSON.stringify(approvalFromEvent(task)));
		return {
			async beforeNative() {
				if (
					!journal.adviceWait(task.delivery)?.resumed &&
					(await readyAdvice())
				)
					throw new NativeLaneYield();
			},
			submitted(head, submission, ready) {
				const prior = journal.adviceWait(task.delivery);
				const wait = { ...submission, head, approval, files };
				if (prior) {
					if (
						!prior.resumed ||
						prior.wait.approval !== approval ||
						(prior.wait.head === head &&
							JSON.stringify(prior.wait) !== JSON.stringify(wait))
					)
						throw Error(
							"Suspended consultation differs from its approved input",
						);
					return;
				}
				if (ready) return;
				const active = journal.activeAdviceWaits();
				if (
					!active.length &&
					!journal
						.workerCandidates()
						.some((candidate) => compatible(filesOf(candidate), files))
				)
					return;
				journal.suspendForAdvice(task.delivery, wait);
				throw new ConsultationDeferred();
			},
		};
	};
	const waits = new Map<string, { epoch: number; retryAt: number }>();
	const hold = (
		event: ReturnType<typeof journal.pendingWorkers>[number],
		error: unknown,
		epoch: number,
	) => {
		const reason =
			error instanceof DependencyHold
				? error.message
				: "GitHub dependency verification is unavailable.";
		waits.set(event.delivery, {
			epoch,
			retryAt: error instanceof DependencyHold ? Infinity : Date.now() + 60000,
		});
		journal.waitForDependencies(event.delivery, "Dependency: " + reason);
		recordProgress(
			state,
			event.issue,
			"dependency-wait:" + reason,
			"JAM held this work card. " + reason,
		);
	};
	const eligibleWorker = async () => {
		if (!dependencyAware)
			return journal.nextWorker(
				(task) => validations.canStart(task, topic.defaultClass),
				(task) => task.body !== WORKER_ACCEPTANCE_BODY,
			);
		const due = await readyAdvice();
		if (due) return journal.resumeAdvice(due.delivery);
		const occupied = journal
			.activeAdviceWaits()
			.flatMap((row) => row.wait.files);
		const epoch = journal.dependencyEpoch();
		for (const task of journal.pendingWorkers()) {
			if (occupied.length && !compatible(filesOf(task), occupied)) continue;
			const previous = waits.get(task.delivery);
			if (
				(previous?.epoch === epoch && previous.retryAt > Date.now()) ||
				!validations.canStart(task, topic.defaultClass)
			)
				continue;
			const card = parseTaskCard(
				task.title,
				task.body,
				task.kind,
				topic.defaultClass,
			);
			if (
				card?.kind === "development" &&
				task.body !== WORKER_ACCEPTANCE_BODY
			) {
				try {
					await verifyDependencies(
						state,
						topic,
						journal.db,
						task.issue,
						signal,
						() =>
							validateTaskApproval(topic, task.issue, approvalFromEvent(task)),
						card.dependencies,
					);
				} catch (error) {
					if (signal.aborted) throw error;
					if (error instanceof DependencyTaskWithdrawn) {
						journal.withdrawPendingWorker(task.delivery);
						waits.delete(task.delivery);
					} else hold(task, error, epoch);
					continue;
				}
				if (epoch !== journal.dependencyEpoch()) return;
			}
			const claimed = journal.nextWorker(
				(candidate) =>
					candidate.delivery === task.delivery &&
					validations.canStart(candidate, topic.defaultClass),
				(candidate) => candidate.body !== WORKER_ACCEPTANCE_BODY,
			);
			if (claimed) {
				waits.delete(task.delivery);
				return claimed;
			}
		}
	};
	prepareReviewNotices(journal.db);
	try {
		journal.db
			.prepare(
				"UPDATE intake SET workerState='pending' WHERE workerState='waiting-decision'",
			)
			.run();
		await migrateReviewNotices(runtime);
		for (const row of journal.db
			.prepare(
				"SELECT delivery,issue FROM intake WHERE state='review' AND reason='Service stopped during dispatch'",
			)
			.all()) {
			const receipt = await recoveredIntake(
				{ issue: Number(row.issue), delivery: String(row.delivery) },
				journal.lead(),
				topic.cwd,
				topic.repository,
			);
			if (receipt) journal.complete(receipt, true);
		}
		while (!signal.aborted) {
			await deliverReviewNotice(runtime, signal);
			const epoch = journal.dependencyEpoch();
			const decision = validations.tick(
				integrations,
				(head) => validateReviewedHead(runtime, head, signal),
				signal,
				Date.now(),
				eligibleIntegration(epoch),
			);
			if (decision.batch) {
				await integrateReady(runtime, signal, integrations, decision.batch);
				continue;
			}
			if (decision.waiting) {
				await delay(250);
				continue;
			}
			const execution = prefillDevelopmentTasks(topic, journal)
				? undefined
				: await eligibleWorker();
			if (execution) {
				try {
					await dispatchApprovedWorker(
						execution,
						topic,
						state,
						signal,
						journal.lead().id,
						{ adviceLane: adviceLane(execution), beforeSpecification },
					);
					journal.finishWorker(execution.delivery);
				} catch (err) {
					if (err instanceof ConsultationDeferred) {
						const wait = journal.adviceWait(execution.delivery)?.wait;
						if (!wait)
							throw Error("Consultation yielded without a recorded checkpoint");
						recordProgress(
							state,
							execution.issue,
							"implementation-advice-awaiting:" + wait.id,
							"Implementation advice is running. JAM released the native lane for a compatible work card.",
						);
						continue;
					}
					if (err instanceof IntegrationLaneYield) {
						journal.parkWorkerForIntegration(execution.delivery);
						continue;
					}
					if (err instanceof NativeLaneYield) {
						journal.yieldWorker(execution.delivery);
						continue;
					}
					if (err instanceof DependencyHold) {
						hold(execution, err, journal.dependencyEpoch());
						continue;
					}
					if (err instanceof DecisionPending) {
						pauseDecision(
							journal.db,
							execution.delivery,
							execution.issue,
							err.message,
						);
						continue;
					}
					if (
						err instanceof PublisherSeedUnavailable ||
						err instanceof ProfileLookupUnavailable
					) {
						journal.deferPublisherSeed(execution.delivery);
						continue;
					}
					if (signal.aborted) return;
					journal.finishWorker(
						execution.delivery,
						err instanceof Error ? err.message : "Worker dispatch failed",
					);
					console.error(
						"Worker dispatch requires review",
						topic.repository,
						execution.issue,
					);
				}
				continue;
			}
			if (
				journal.hasIntegrationContinuation() ||
				!journal.hasQueuedIntake() ||
				(await nativeLeadOccupied(state))
			) {
				await delay(500);
				continue;
			}
			const event = journal.next();
			if (!event) {
				await delay(500);
				continue;
			}
			try {
				if (event.action === "task") {
					await validateTaskApproval(
						topic,
						event.issue,
						approvalFromEvent(event),
					);
					const card = parseTaskCard(
						event.title,
						event.body,
						event.kind,
						topic.defaultClass,
					);
					if (card) beginDashboard(state, event.issue, card.kind);
				}
				let profile:
					| Awaited<ReturnType<typeof refreshProjectValues>>
					| undefined;
				if (event.action === "task") {
					try {
						profile = await refreshProjectValues(
							topic,
							state,
							event.issue,
							signal,
						);
					} catch (err) {
						if (
							!(err instanceof ProfileLookupUnavailable) &&
							(!(err instanceof Error) ||
								!/^Profile broker: Repository outside (?:publisher|profile reader) scope$/.test(
									err.message,
								))
						)
							throw err;
						journal.deferProfile(event.delivery);
						recordProgress(
							state,
							event.issue,
							"waiting-profile",
							"Waiting for project profile read access. JAM will retry automatically.",
						);
						continue;
					}
				}
				const ack = await notifyLeo(
					event,
					journal.lead(),
					topic.cwd,
					topic.repository,
					signal,
					profile?.markdown,
					usesDependencies(topic),
				);
				journal.complete(ack);
				console.log("JAM acknowledged issue", topic.repository, event.issue);
			} catch (err) {
				if (signal.aborted) return;
				if (err instanceof TaskWithdrawn) {
					journal.withdrawIntake(event.delivery);
					continue;
				}
				journal.fail(
					event.delivery,
					err instanceof Error ? err.message : "Dispatch failed",
				);
				console.error(
					"JAM intake requires review",
					topic.repository,
					event.issue,
				);
			}
		}
	} finally {
		await validations.settle();
	}
}
async function main() {
	const state = resolve(required("JAM_STATE_DIR"));
	const [cmd, action, id, decision, operator, session] = process.argv.slice(2);
	if (cmd === "review") {
		const selector =
			process.env.JAM_REVIEW_REPOSITORY || required("JAM_REPOSITORY");
		const route = configuredTopics(state).find(
			(route) => route.topic.repository === selector,
		);
		if (!route) throw new Error("Unconfigured review repository");
		const journal = new Journal(join(route.state, "intake.sqlite"));
		try {
			if (action === "backfill" && id && /^[1-9][0-9]*$/.test(id)) {
				const { backfillTimeline } = await import("./reconcile-timeline.js");
				await backfillTimeline(route, Number(id));
			} else if (action === "list")
				console.log(
					JSON.stringify(
						{
							repository: selector,
							session: journal.lead(),
							deliveries: journal.list(),
							pendingTimeline: pendingProgress(route.state),
						},
						null,
						2,
					),
				);
			else if (action === "retry-integration" && id && decision && operator)
				new IntegrationQueue(journal.db).retryFailed(id, operator, decision);
			else if (action === "resolve" && id && decision && operator && session)
				journal.resolve(id, decision, operator, session);
			else if (action === "retry-seed" && id && decision) {
				const row = journal.list().find((r) => r.delivery === id);
				if (!row) throw Error("Unknown delivery");
				const assignment = join(route.state, "assignments", String(row.issue));
				if (
					(await readdir(assignment)).length ||
					(
						await readdir(join(route.state, "worktrees")).catch(
							(e: NodeJS.ErrnoException) => {
								if (e.code !== "ENOENT") throw e;
								return [] as string[];
							},
						)
					).includes(String(row.issue))
				)
					throw Error("Existing task work requires reconciliation");
				journal.retryDeniedSeed(id, decision);
			} else if (action === "resolve-worker" && id && decision && operator)
				journal.resolveWorker(id, decision, operator);
			else
				throw new Error(
					"Expected review list, review resolve DELIVERY acked|abandon|requeue OPERATOR resume|unused, or review resolve-worker DELIVERY complete|abandon OPERATOR",
				);
		} finally {
			journal.db.close();
		}
		return;
	}
	if (cmd) throw new Error("Unknown service command");
	await requireOwnerLock(join(state, "owner.lock"));
	const secret = (
		await readFile(required("JAM_WEBHOOK_SECRET_FILE"), "utf8")
	).trim();
	if (!secret) throw new Error("Missing signing secret");
	const routes = await openTopics(state, pausedRepositories(state));
	await restoreManagedTopics(state, routes);
	const admissions = new TaskAdmission();

	const stop = new AbortController();
	const consumers = new Set<Promise<void>>();
	let failure: unknown;
	let serving = false;
	const started = new Map<
		number,
		{ abort: AbortController; done: Promise<void> }
	>();
	const start = (route: TopicRuntime) => {
		if (!serving || stop.signal.aborted || started.has(route.topic.repoId))
			return;
		const abort = new AbortController(),
			signal = AbortSignal.any([abort.signal, stop.signal]);
		const task = withoutEnvironmentAuthority(async () => {
			await admissions.recover([route]);
			const tasks = [
				consume(route, signal),
				publishTimeline(route.state, route.topic, signal),
				deliverConnectionNotice(route, signal),
			];
			try {
				await Promise.all(tasks);
			} finally {
				abort.abort();
				await Promise.allSettled(tasks);
			}
		}).catch((err) => {
			if (
				!stop.signal.aborted &&
				routes.has(route.topic.installation + "/" + route.topic.repoId)
			) {
				failure = err;
				stop.abort();
			}
		});
		started.set(route.topic.repoId, { abort, done: task });
		consumers.add(task);
		void task.finally(() => consumers.delete(task));
	};
	let control: Awaited<ReturnType<typeof createManagement>> | undefined;
	const requests = new Set<Promise<Record<string, unknown>>>();
	const connect = projectConnector(
		state,
		routes,
		start,
		undefined,
		async (route) => {
			const worker = started.get(route.topic.repoId);
			if (worker) {
				worker.abort.abort();
				await worker.done;
				started.delete(route.topic.repoId);
			}
		},
		async (repository, paused) => {
			const [owner, name] = repository.toLowerCase().split("/");
			const dir = join(
				process.env.JAM_PROFILE_EXCHANGE ?? "/var/lib/jam-profile-exchange",
				"revoked",
				owner!,
			);
			if (paused) {
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, name!), "revoked\n");
			} else await rm(join(dir, name!), { force: true });
		},
	);
	const grants = new InstallationGrants(state, routes, connect);
	const management = await configuredManagement(async () => {
		const api = await createManagement(state, routes, start, connect);
		control = api;
		return {
			operations: api.operations,
			invoke: async (name, input) => {
				const pending = api.invoke(name, input);
				requests.add(pending);
				try {
					return await pending;
				} finally {
					requests.delete(pending);
				}
			},
		};
	});
	const server = webhook(
		routes,
		secret,
		undefined,
		admissions,
		management,
		grants,
	);
	await new Promise<void>((ok, fail) => {
		server.once("error", fail);
		server.listen(19739, "0.0.0.0", ok);
	});
	// Reconcile acknowledged membership changes before resuming earlier assignments.
	while (await grants.next()) {}
	serving = true;
	const grantWorker = grants.run(stop.signal).catch((error) => {
		failure = error;
		stop.abort();
	});
	const done = new Promise<void>((ok) =>
		stop.signal.addEventListener("abort", () => ok(), { once: true }),
	);
	const shutdown = () => stop.abort();
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	try {
		for (const route of routes.values()) start(route);
		console.log("Signed issue intake ready for", routes.size, "repositories");
		await done;
	} finally {
		const closed = new Promise<void>((ok) => server.close(() => ok()));
		server.closeIdleConnections();
		await Promise.all([closed, grantWorker, ...consumers]);
		grants.db.close();
		await Promise.allSettled(requests);
		await control?.settle();
		for (const route of routes.values()) route.journal.db.close();
	}
	if (failure) throw failure;
}
if (
	process.argv[1] &&
	pathToFileURL(await realpath(process.argv[1])).href === import.meta.url
)
	main().catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	});
