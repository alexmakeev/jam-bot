import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { profileKinds } from "./profile-card.js";
import { Journal, type Topic } from "./intake-journal.js";

type Binding = Omit<Topic, "cwd">;
export interface TopicRuntime {
	topic: Topic;
	state: string;
	journal: Journal;
}

function binding(value: unknown): Binding {
	if (!value || typeof value !== "object")
		throw new Error("Expected a configured topic");
	const { repository, repoId, installation, defaultClass } = value as Binding;
	if (
		typeof repository !== "string" ||
		!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
		!Number.isSafeInteger(repoId) ||
		repoId <= 0 ||
		!Number.isSafeInteger(installation) ||
		installation <= 0
	) {
		throw new Error(
			"Invalid repository name or numeric installation/repository ID",
		);
	}
	if (defaultClass !== undefined && !profileKinds.includes(defaultClass))
		throw Error("Invalid repository default class");
	return {
		repository,
		repoId,
		installation,
		...(defaultClass ? { defaultClass } : {}),
	};
}

export function topicKey(installation: number, repoId: number): string {
	return installation + "/" + repoId;
}

export function configuredTopics(root: string, env = process.env) {
	const additional: unknown = JSON.parse(env.JAM_ADDITIONAL_TOPICS || "[]");
	if (!Array.isArray(additional))
		throw new Error("JAM_ADDITIONAL_TOPICS must be an array");
	const primary = env.JAM_REPOSITORY
		? [
				binding({
					repository: env.JAM_REPOSITORY,
					repoId: Number(env.JAM_REPOSITORY_ID),
					installation: Number(env.JAM_INSTALLATION_ID),
					defaultClass: env.JAM_DEFAULT_CLASS,
				}),
			]
		: [];
	const topics = [...primary, ...additional.map(binding)];
	if (
		new Set(topics.map((topic) => topic.repoId)).size !== topics.length ||
		new Set(topics.map((topic) => topic.repository.toLowerCase())).size !==
			topics.length
	)
		throw new Error("Duplicate repository binding");
	return topics.map((topic, index) => {
		const state =
			index === 0 && primary.length
				? root
				: join(root, "topics", topicKey(topic.installation, topic.repoId));
		return { topic: { ...topic, cwd: join(state, "leo") }, state };
	});
}

export async function openTopic(
	state: string,
	topic: Topic,
): Promise<TopicRuntime> {
	await mkdir(topic.cwd, { recursive: true, mode: 0o700 });
	const journal = new Journal(join(state, "intake.sqlite"));
	try {
		journal.start(topic);
		return { topic, state, journal };
	} catch (error) {
		journal.db.close();
		throw error;
	}
}

export async function openTopics(
	root: string,
	paused: ReadonlySet<number> = new Set(),
	env = process.env,
): Promise<Map<string, TopicRuntime>> {
	const routes = new Map<string, TopicRuntime>();
	try {
		for (const { topic, state } of configuredTopics(root, env)) {
			if (paused.has(topic.repoId)) continue;
			routes.set(
				topicKey(topic.installation, topic.repoId),
				await openTopic(state, topic),
			);
		}
		return routes;
	} catch (err) {
		for (const route of routes.values()) route.journal.db.close();
		throw err;
	}
}
