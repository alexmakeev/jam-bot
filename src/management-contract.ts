import { z } from "zod";
import type { TopicRuntime } from "./topics.js";

export class ManagementError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface ManagementOperation {
	name: string;
	description: string;
	input: z.ZodObject;
	output: z.ZodObject;
	mutate: boolean;
	run(input: any): Promise<Record<string, unknown>>;
}

export const targetFields = {
	serverId: z.uuid(),
	repoId: z.number().int().positive(),
};

export function requireServer(expected: string, received: string) {
	if (expected !== received)
		throw new ManagementError(
			409,
			"wrong_server",
			"The destination server identity has changed.",
		);
}

export function requireTopic(
	routes: ReadonlyMap<string, TopicRuntime>,
	repoId: number,
): TopicRuntime {
	for (const route of routes.values())
		if (route.topic.repoId === repoId) return route;
	throw new ManagementError(
		404,
		"topic_not_found",
		"This server does not manage the selected repository.",
	);
}
