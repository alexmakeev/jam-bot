import { z } from "zod";
import {
	ManagementError,
	requireTopic,
	targetFields,
	type ManagementOperation,
} from "./management-contract.js";
import type { TopicRuntime } from "./topics.js";

const target = z.strictObject({ ...targetFields, requestId: z.uuid() });
const result = z.strictObject({
	requestId: z.uuid(),
	environment: z.string(),
	revision: z.string(),
	state: z.enum(["running", "succeeded", "failed", "interrupted"]),
	message: z.string().nullable(),
});

function prepare(route: TopicRuntime) {
	route.journal.db.exec(`CREATE TABLE IF NOT EXISTS management_deployments(
    requestId TEXT PRIMARY KEY, environment TEXT NOT NULL, revision TEXT NOT NULL, approvalId INTEGER,
    state TEXT NOT NULL, message TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_management_deployment ON management_deployments(environment) WHERE state='running'`);
}

export function deploymentJobs(
	routes: ReadonlyMap<string, TopicRuntime>,
	deploy: ManagementOperation,
	active: Set<Promise<void>>,
): ManagementOperation[] {
	for (const route of routes.values()) {
		prepare(route);
		route.journal.db.exec(
			"UPDATE management_deployments SET state='interrupted', message='Check environment_status before retrying.' WHERE state='running'",
		);
	}
	const projection =
		"SELECT requestId,environment,revision,state,message FROM management_deployments WHERE requestId=?";
	return [
		{
			name: "start_environment_deployment",
			description:
				"Start a verified environment deployment and return a durable operation handle. Reuse the same requestId on retry.",
			input: deploy.input.extend({ requestId: z.uuid() }),
			output: result,
			mutate: true,
			run: async (input) => {
				const route = requireTopic(routes, input.repoId);
				prepare(route);
				const db = route.journal.db;
				const { requestId, ...args } = input;
				const existing = db
					.prepare("SELECT * FROM management_deployments WHERE requestId=?")
					.get(requestId);
				if (existing) {
					if (
						existing.environment !== args.environment ||
						existing.revision !== args.revision ||
						existing.approvalId !== (args.approvalCommentId ?? null)
					)
						throw new ManagementError(
							409,
							"request_conflict",
							"This request ID belongs to a different deployment.",
						);
				} else {
					if (
						db
							.prepare(
								"SELECT 1 FROM management_deployments WHERE environment=? AND state='running'",
							)
							.get(args.environment)
					)
						throw new ManagementError(
							409,
							"deployment_active",
							"A deployment for this environment is already running.",
						);
					db.prepare(
						"INSERT INTO management_deployments VALUES(?,?,?,?,'running',NULL)",
					).run(
						requestId,
						args.environment,
						args.revision,
						args.approvalCommentId ?? null,
					);
					const finish = db.prepare(
						"UPDATE management_deployments SET state=?,message=? WHERE requestId=?",
					);
					const job = Promise.resolve()
						.then(() => deploy.run(args))
						.then((value) => {
							if (value.healthy !== true || value.revision !== args.revision)
								throw Error("Revision not confirmed");
							finish.run("succeeded", null, requestId);
						})
						.catch((err) => {
							finish.run(
								"failed",
								err instanceof ManagementError
									? err.message
									: "Deployment failed. Inspect the environment status and host log.",
								requestId,
							);
						});
					active.add(job);
					void job.then(
						() => active.delete(job),
						() => active.delete(job),
					);
				}
				return db.prepare(projection).get(requestId)!;
			},
		},
		{
			name: "operation_status",
			description:
				"Read the saved outcome of an asynchronous deployment, including after a client reconnects.",
			input: target,
			output: result,
			mutate: false,
			run: async (input) => {
				const route = requireTopic(routes, input.repoId);
				prepare(route);
				const row = route.journal.db.prepare(projection).get(input.requestId);
				if (!row)
					throw new ManagementError(
						404,
						"operation_not_found",
						"This project has no deployment with that request ID.",
					);
				return row;
			},
		},
	];
}
