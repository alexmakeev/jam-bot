import { z } from "zod";
import { availableProjects, availableInstallations } from "./github-app.js";
import { taskOperations } from "./management-tasks.js";
import { IntegrationQueue } from "./integration-queue.js";
import { deploymentJobs } from "./management-jobs.js";
import { environmentOperations } from "./management-environments.js";
import { secretOperations } from "./management-secrets.js";
import { diagnosticOperations } from "./management-diagnostics.js";
import {
	ManagementError,
	requireServer,
	requireTopic,
	targetFields,
	type ManagementOperation,
} from "./management-contract.js";
import {
	configureTopic,
	projectConnector,
	serverIdentity,
	sourceUri,
	workClass,
} from "./management-projects.js";
import type { TopicRuntime } from "./topics.js";

const target = z.strictObject(targetFields);
const topicSchema = z.strictObject({
	repoId: z.int().positive(),
	repository: z.string(),
	sourceUri: z.url(),
	installationId: z.int().positive(),
	profile: z.literal("leo-developer"),
	defaultClass: workClass,
	defaultEnvironment: z.string().nullable(),
});
function describe({ topic }: TopicRuntime) {
	return {
		repoId: topic.repoId,
		repository: topic.repository,
		sourceUri: "https://github.com/" + topic.repository,
		installationId: topic.installation,
		profile: "leo-developer",
		defaultClass: topic.defaultClass ?? "development",
		defaultEnvironment: topic.defaultEnvironment ?? null,
	};
}

const delivery = z.strictObject({
	delivery: z.string(),
	issue: z.number(),
	action: z.string(),
	state: z.string(),
	workerState: z.string().nullable(),
});
const branch = z.strictObject({
	issue: z.int(),
	branch: z.string(),
	sha: z.string(),
});
const inventory = z.strictObject({
	serverId: z.uuid(),
	topics: z.array(topicSchema),
});
const page = z.int().positive().default(1);
const ok = z.strictObject({ updated: z.literal(true) });

export async function createManagement(
	state: string,
	routes: Map<string, TopicRuntime>,
	onTopicAdded: (topic: TopicRuntime) => void = () => {},
	connect = projectConnector(state, routes, onTopicAdded),
) {
	const serverId = serverIdentity(state);
	const name = process.env.JAM_SERVER_NAME || "JAM-Bot";
	const projects = () =>
		Array.from(routes.values(), describe).sort((a, b) =>
			a.repository.localeCompare(b.repository),
		);
	const active = new Set<Promise<void>>();
	const environments = await environmentOperations(state, routes, serverId);
	const operations: ManagementOperation[] = [
		{
			name: "server_status",
			description: "Identify the connected server and its current topics.",
			input: z.strictObject({}),
			output: inventory.extend({ name: z.string() }),
			mutate: false,
			run: async () => ({ serverId, name, topics: projects() }),
		},
		{
			name: "list_topics",
			description:
				"List repository source URIs, live topic IDs, and the active work profile.",
			input: z.strictObject({}),
			output: inventory,
			mutate: false,
			run: async () => ({ serverId, topics: projects() }),
		},
		{
			name: "list_installations",
			description:
				"List one page of GitHub installations accessible to this server’s GitHub App.",
			input: z.strictObject({ page }),
			output: z.strictObject({
				installations: z.array(
					z.strictObject({
						installationId: z.int(),
						account: z.string(),
						suspended: z.boolean(),
					}),
				),
			}),
			mutate: false,
			run: async ({ page }) => ({
				installations: await availableInstallations(page),
			}),
		},
		{
			name: "available_projects",
			description:
				"Discover repositories granted to the selected GitHub installation.",
			input: z.strictObject({ installationId: z.int().positive(), page }),
			output: z.strictObject({
				total: z.int(),
				projects: z.array(
					z.strictObject({ repoId: z.int(), sourceUri: z.url() }),
				),
			}),
			mutate: false,
			run: async ({ installationId, page }) =>
				availableProjects(installationId, page),
		},
		{
			name: "connect_project",
			description:
				"Verify the GitHub App grant, persist the repository binding and start its JAM consumer.",
			input: z.strictObject({
				serverId: z.uuid(),
				sourceUri,
				installationId: z.int().positive(),
			}),
			output: topicSchema,
			mutate: true,
			run: async ({ sourceUri, installationId }) =>
				describe(await connect(sourceUri, installationId)),
		},
		{
			name: "configure_topic",
			description:
				"Set the persistent default work class used by JAM for this repository.",
			input: target.extend({
				defaultClass: workClass.optional(),
				defaultEnvironment: z
					.string()
					.regex(/^[a-z][a-z0-9-]{0,39}$/)
					.nullable()
					.optional(),
			}),
			output: topicSchema,
			mutate: true,
			run: async ({ repoId, defaultClass, defaultEnvironment }) => {
				const route = requireTopic(routes, repoId);
				if (defaultClass === undefined && defaultEnvironment === undefined)
					throw new ManagementError(
						400,
						"missing_setting",
						"Specify a default work class or environment.",
					);
				if (typeof defaultEnvironment === "string")
					await environments
						.find((op) => op.name === "environment_get")!
						.run({ serverId, repoId, environment: defaultEnvironment });
				configureTopic(
					state,
					route,
					defaultClass ?? route.topic.defaultClass ?? "development",
					defaultEnvironment === undefined
						? (route.topic.defaultEnvironment ?? null)
						: defaultEnvironment,
				);
				return describe(route);
			},
		},
		{
			name: "topic_status",
			description:
				"Inspect the coordinator, recent work cards and current integration queue.",
			input: target.extend({ limit: z.int().min(1).max(100).default(20) }),
			output: z.strictObject({
				topic: topicSchema,
				sessionEstablished: z.boolean(),
				work: z.array(delivery),
				ready: z.array(branch),
				integrating: z
					.strictObject({ id: z.string(), entries: z.array(branch) })
					.nullable(),
			}),
			mutate: false,
			run: async ({ repoId, limit }) => {
				const route = requireTopic(routes, repoId);
				const queue = new IntegrationQueue(route.journal.db).snapshot();
				const work = route.journal.db
					.prepare(
						"SELECT delivery,issue,action,state,workerState FROM intake ORDER BY rowid DESC LIMIT ?",
					)
					.all(limit);
				return {
					topic: describe(route),
					sessionEstablished: route.journal.lead().established,
					work,
					ready: queue.ready,
					integrating: queue.active ?? null,
				};
			},
		},
		{
			name: "resolve_intake",
			description:
				"Resolve an intake already stopped for operator review, retaining an audit reason.",
			input: target.extend({
				delivery: z.uuid(),
				decision: z.enum(["acked", "abandon", "requeue"]),
				session: z.enum(["resume", "unused"]),
				reason: z.string().trim().min(1).max(500),
			}),
			output: ok,
			mutate: true,
			run: async ({ repoId, delivery, decision, session, reason }) => {
				try {
					requireTopic(routes, repoId).journal.resolve(
						delivery,
						decision,
						"management owner: " + reason,
						session,
					);
				} catch (error) {
					if (error instanceof ManagementError) throw error;
					throw new ManagementError(
						409,
						"review_conflict",
						"This intake cannot accept the selected resolution.",
					);
				}
				return { updated: true };
			},
		},
		{
			name: "retry_integration",
			description:
				"Retry a previously failed integration after the operator has reconciled the failure.",
			input: target.extend({
				batchId: z.uuid(),
				reason: z.string().trim().min(1).max(500),
			}),
			output: ok,
			mutate: true,
			run: async ({ repoId, batchId, reason }) => {
				const { journal } = requireTopic(routes, repoId);
				try {
					new IntegrationQueue(journal.db).retryFailed(
						batchId,
						"management owner",
						reason,
					);
				} catch {
					throw new ManagementError(
						409,
						"batch_conflict",
						"This integration batch cannot be retried in its current state.",
					);
				}
				return { updated: true };
			},
		},
		{
			name: "resolve_worker",
			description:
				"Record the reconciled outcome for a worker already stopped for review.",
			input: target.extend({
				delivery: z.uuid(),
				decision: z.enum(["complete", "abandon"]),
				reason: z.string().trim().min(1).max(500),
			}),
			output: ok,
			mutate: true,
			run: async ({ repoId, delivery, decision, reason }) => {
				const { journal } = requireTopic(routes, repoId);
				try {
					journal.resolveWorker(
						delivery,
						decision,
						"management owner: " + reason,
					);
				} catch {
					throw new ManagementError(
						409,
						"review_conflict",
						"This worker is not awaiting reconciliation.",
					);
				}
				return { updated: true };
			},
		},
		...taskOperations(routes),
		...secretOperations(routes, serverId),
		...diagnosticOperations(routes),
		...environments,
		...deploymentJobs(
			routes,
			environments.find((op) => op.name === "environment_deploy")!,
			active,
		),
	];
	return {
		operations,
		settle: () => Promise.allSettled(active),
		invoke: async (name: string, raw: unknown) => {
			const op = operations.find((item) => item.name === name);
			if (!op)
				throw new ManagementError(
					404,
					"unknown_operation",
					"Unknown management operation.",
				);
			const input = op.input.parse(raw);
			if (op.mutate || typeof input.serverId === "string")
				requireServer(serverId, String(input.serverId));
			const value = await op.run(input);
			const checked = op.output.safeParse(value);
			if (!checked.success)
				throw new ManagementError(
					500,
					"invalid_result",
					"The operation returned an unexpected result.",
				);
			return checked.data;
		},
	};
}
