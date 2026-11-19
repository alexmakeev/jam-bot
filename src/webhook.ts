import { startHumanTurn } from "./work-progress.js";
import type { InstallationGrants } from "./installation-grants.js";
import { decisionReply, wakeDecision } from "./material-decision.js";
import { storeReleaseApprovalHint } from "./release-approval-hint.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { topicKey, type TopicRuntime } from "./topics.js";
import type { ManagementHandler } from "./management-transport.js";
import { TaskAdmission } from "./task-admission.js";
import { hasTaskWriteAccess, taskClass } from "./task-approval.js";
import { usesDependencies } from "./github-dependencies.js";

type Routes = ReadonlyMap<string, TopicRuntime>;

const limit = 2 * 1024 * 1024;
const deliveryId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
async function receive(
	req: IncomingMessage,
	res: ServerResponse,
	routes: Routes,
	secret: string,
	canApprove: typeof hasTaskWriteAccess,
	admission: TaskAdmission,
	grants?: InstallationGrants,
) {
	const end = (status: number, data?: string) => {
		res.writeHead(status);
		res.end(data);
	};
	if (req.method === "GET" && req.url === "/health") {
		for (const { journal } of routes.values())
			journal.db.prepare("SELECT 1").get();
		return end(200, "ready\n");
	}
	if (req.method !== "POST" || req.url !== "/github") return end(404);
	const sig = req.headers["x-hub-signature-256"];
	if (typeof sig !== "string" || !/^sha256=[0-9a-f]{64}$/.test(sig))
		return end(403);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > limit) {
			res.setHeader("Connection", "close");
			return end(413);
		}
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	const expected = createHmac("sha256", secret).update(bytes).digest();
	if (!timingSafeEqual(expected, Buffer.from(sig.slice(7), "hex")))
		return end(403);
	let data: ReturnType<typeof JSON.parse>;
	try {
		data = JSON.parse(bytes.toString("utf8"));
	} catch {
		return end(400);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return end(400);
	const type = req.headers["x-github-event"];
	if (
		(type === "installation" && ["created", "deleted"].includes(data.action)) ||
		(type === "installation_repositories" &&
			["added", "removed"].includes(data.action))
	)
		return end(
			grants
				? grants.accept(type, req.headers["x-github-delivery"], data)
				: 204,
		);
	const approvalComment =
		type === "issue_comment" &&
		data.action === "created" &&
		data.comment?.body?.startsWith?.("Approve JAM-Bot stable release of ");
	const decision =
		type === "issue_comment" &&
		data.action === "created" &&
		typeof data.comment?.body === "string" &&
		decisionReply.exec(data.comment.body);
	const humanComment =
		type === "issue_comment" &&
		data.action === "created" &&
		data.sender?.type === "User" &&
		data.comment?.user?.id === data.sender.id &&
		!data.issue?.pull_request &&
		Number.isSafeInteger(data.issue?.number) &&
		Number.isSafeInteger(data.comment.id) &&
		data.comment.id > 0;
	const dependencyEvent =
		type === "issue_dependencies" &&
		[
			"blocked_by_added",
			"blocked_by_removed",
			"blocking_added",
			"blocking_removed",
		].includes(data.action);
	const withdrawal =
		type === "issues" &&
		data.action === "closed" &&
		data.issue?.state_reason === "not_planned" &&
		!data.issue.pull_request;
	if (
		!dependencyEvent &&
		!withdrawal &&
		!humanComment &&
		!decision &&
		!approvalComment &&
		(type !== "issues" || !["opened", "typed"].includes(data.action))
	)
		return end(204);
	const repoId = data.repository?.id;
	const installation = data.installation?.id;
	if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(installation))
		return end(403);
	const route = routes.get(topicKey(installation, repoId));
	if (!route || data.repository.full_name !== route.topic.repository)
		return end(403);
	if (dependencyEvent || withdrawal) {
		if (!usesDependencies(route.topic)) return end(204);
		const delivery = req.headers["x-github-delivery"];
		if (typeof delivery !== "string" || !deliveryId.test(delivery))
			return end(400);
		route.journal.wakeDependencies(delivery.toLowerCase());
		return end(204);
	}
	if (humanComment)
		startHumanTurn(route.state, data.issue.number, data.comment.id);
	if (decision) {
		if (
			data.sender?.type === "User" &&
			data.sender.id === data.comment.user?.id &&
			!data.issue?.pull_request &&
			Number.isSafeInteger(data.issue?.number)
		)
			wakeDecision(route.journal.db, data.issue.number, decision[2]!);
		return end(204);
	}
	if (approvalComment) {
		if (!data.issue?.pull_request && data.sender?.type === "User")
			await storeReleaseApprovalHint(
				process.env.JAM_PROFILE_EXCHANGE ?? "/var/lib/jam-profile-exchange",
				repoId,
				route.topic.repository,
				data.issue?.number,
				data.comment,
				data.sender.id,
			);
		return end(204);
	}
	if (humanComment) return end(204);
	const delivery = req.headers["x-github-delivery"];
	const issue = data.issue;
	if (!issue || typeof issue !== "object") return end(400);
	// GitHub sends a separate typed delivery even when Task was selected during creation.
	// An opened payload without its own type evidence cannot establish who set a later type.
	const taskType = data.action === "typed" ? data.type : issue.type;
	if (taskType?.name !== "Task" || issue.pull_request) return end(204);
	const actor = data.sender;
	if (
		actor?.type !== "User" ||
		!Number.isSafeInteger(actor.id) ||
		actor.id <= 0 ||
		typeof actor.login !== "string" ||
		!/^[A-Za-z0-9-]+$/.test(actor.login)
	)
		return end(204);
	if (data.action === "opened" && issue.user?.id !== actor.id) return end(204);
	if (
		typeof delivery !== "string" ||
		!deliveryId.test(delivery) ||
		!Number.isSafeInteger(taskType.id) ||
		taskType.id <= 0 ||
		!Number.isSafeInteger(issue.number) ||
		issue.number <= 0 ||
		typeof issue.title !== "string" ||
		!issue.title.trim() ||
		!(issue.body == null || typeof issue.body === "string")
	)
		return end(400);
	if (issue.title.length > 512 || (issue.body?.length ?? 0) > 65536)
		return end(413);
	const author = issue.user;
	if (
		author?.type !== "User" ||
		!Number.isSafeInteger(author.id) ||
		author.id <= 0 ||
		typeof author.login !== "string" ||
		!/^[A-Za-z0-9-]+$/.test(author.login)
	)
		return end(204);
	let kind: ReturnType<typeof taskClass>;
	try {
		kind = taskClass(issue.labels);
	} catch {
		return end(422);
	}
	if (
		!(await canApprove(route.topic, actor)) ||
		(author.id !== actor.id && !(await canApprove(route.topic, author)))
	)
		return end(204);
	const status = await admission.admit(route, {
		delivery,
		issue: issue.number,
		action: "task",
		approvalSource: data.action,
		typeId: taskType.id,
		actorId: actor.id,
		actorLogin: actor.login,
		authorId: author.id,
		authorLogin: author.login,
		kind,
		title: issue.title,
		body: issue.body ?? "",
	});
	return end(status);
}
export function webhook(
	routes: Routes,
	secret: string,
	canApprove = hasTaskWriteAccess,
	admission = new TaskAdmission(),
	management?: ManagementHandler,
	grants?: InstallationGrants,
) {
	return createServer(
		{ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16384 },
		(req, res) => {
			const isManagement =
				req.url === "/mcp" || req.url?.startsWith("/api/v1/");
			const handled =
				management && isManagement
					? management(req, res)
					: receive(req, res, routes, secret, canApprove, admission, grants);
			handled.catch(() => {
				if (!res.headersSent) res.writeHead(503);
				res.end();
			});
		},
	);
}
