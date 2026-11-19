import { parseTaskCard } from "./profile-card.js";
import type { TaskApproval } from "./task-approval.js";

interface RepoIssue {
	number: number;
	state: string;
	locked: boolean;
	pull_request?: unknown;
	title: string;
	body?: string;
	type?: { id: number; name: string };
	user: { id: number; type: string };
	labels: { name: string }[];
}
interface Permission {
	permission: string;
	user: { id: number; type: string };
}
type Access = (login: string) => Promise<Permission>;

// Approval was captured at signed webhook admission. The host independently rechecks its scope before writing.
export async function brokerFiles(
	number: number,
	issue: RepoIssue,
	approval: TaskApproval,
	access: Access,
): Promise<string[]> {
	if (
		!approval ||
		!Number.isSafeInteger(number) ||
		issue.number !== number ||
		issue.pull_request ||
		issue.state !== "open" ||
		!issue.locked ||
		issue.type?.name !== "Task" ||
		issue.type.id !== approval.typeId ||
		issue.user?.type !== "User" ||
		issue.user.id !== approval.author?.id ||
		issue.title !== approval.title ||
		(issue.body ?? "") !== approval.body
	)
		throw Error("Current Task differs from approved scope");
	const labels = issue.labels
		.filter((label) => label.name.startsWith("class:"))
		.map((label) => label.name.slice(6));
	if (labels.length > 1 || labels[0] !== approval.kind)
		throw Error("Task class changed after approval");
	for (const actor of new Map(
		[approval.author, approval.actor].map((a) => [a?.id, a]),
	).values()) {
		if (
			!actor ||
			actor.type !== "User" ||
			!Number.isSafeInteger(actor.id) ||
			actor.id < 1 ||
			!/^[a-z\d-]+$/i.test(actor.login)
		)
			throw Error("Invalid approved Task actor");
		const actual = await access(actor.login);
		if (
			actual.user?.id !== actor.id ||
			actual.user.type !== "User" ||
			!["admin", "write"].includes(actual.permission)
		)
			throw Error("Task author or approver lacks effective write access");
	}
	const profile = parseTaskCard(issue.title, approval.body, approval.kind);
	if (!profile || profile.kind !== "development" || !profile.files.length)
		throw Error("Task has no authorized development files");
	return profile.files;
}
