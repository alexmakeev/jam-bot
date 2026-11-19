import { ownPilotIssue } from "./own-pilot.js";
import type { Intake } from "./intake-journal.js";
import {
	approvalFromEvent,
	TaskApprovalDenied,
	validateTaskApproval,
} from "./task-approval.js";
import type { TopicRuntime } from "./topics.js";

/** Provider mutation is idempotent; persist the immutable signed intent before issuing it. */
export class TaskAdmission {
	private readonly inFlight = new Map<string, Promise<number>>();
	constructor(private readonly protect = validateTaskApproval) {}

	admit(route: TopicRuntime, event: Intake): Promise<number> {
		const pilot = ownPilotIssue(route);
		if (pilot !== undefined && event.issue !== pilot)
			return Promise.resolve(409);
		const saved = route.journal.beginAdmission(event);
		if (!saved || saved.state === "rejected") return Promise.resolve(409);
		if (saved.state !== "admitting") return Promise.resolve(202);
		const key = route.topic.repoId + ":" + saved.event.delivery;
		const prior = this.inFlight.get(key);
		if (prior) return prior;
		const pending = this.lock(route, saved.event).finally(() =>
			this.inFlight.delete(key),
		);
		this.inFlight.set(key, pending);
		return pending;
	}

	private async lock(route: TopicRuntime, event: Intake): Promise<number> {
		try {
			await this.protect(
				route.topic,
				event.issue,
				approvalFromEvent(event),
				true,
			);
			route.journal.finishAdmission(event.delivery);
			return 202;
		} catch (err) {
			if (!(err instanceof TaskApprovalDenied)) throw err; // Retryable failures remain durable.
			route.journal.finishAdmission(event.delivery, err.message);
			return 409;
		}
	}

	async recover(routes: Iterable<TopicRuntime>) {
		for (const route of routes) {
			for (const event of route.journal.pendingAdmissions()) {
				try {
					await this.admit(route, event);
				} catch {
					console.error(
						"Task admission awaits redelivery",
						route.topic.repository,
						event.issue,
					);
				}
			}
		}
	}
}
