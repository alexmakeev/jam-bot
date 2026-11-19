import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { profileKinds } from "./profile-card.js";
import { openTopic, topicKey, type TopicRuntime } from "./topics.js";
import { ManagementError } from "./management-contract.js";
import { inspectProject } from "./github-app.js";

export const workClass = z.enum(profileKinds);
export const repositoryName = z
	.string()
	.regex(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/)
	.refine((value) => ![".", ".."].includes(value.split("/")[1] ?? ""));
export const sourceUri = z
	.string()
	.regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)
	.refine(
		(value) =>
			repositoryName.safeParse(value.slice("https://github.com/".length))
				.success,
	);

function catalog<T>(state: string, action: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(join(state, "management.sqlite"));
	try {
		db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS server (singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(repoId INTEGER PRIMARY KEY,repository TEXT NOT NULL COLLATE NOCASE UNIQUE,
        installation INTEGER NOT NULL, defaultClass TEXT);
      CREATE TABLE IF NOT EXISTS project_locations(repoId INTEGER PRIMARY KEY,repository TEXT NOT NULL,installation INTEGER NOT NULL,directory TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS defaults(repoId INTEGER PRIMARY KEY,kind TEXT NOT NULL,environment TEXT);`);
		return action(db);
	} finally {
		db.close();
	}
}

export function serverIdentity(state: string): string {
	return catalog(state, (db) => {
		const pinned =
			process.env.JAM_SERVER_ID === undefined
				? undefined
				: z.uuid().parse(process.env.JAM_SERVER_ID);
		db.prepare("INSERT OR IGNORE INTO server VALUES(1,?)").run(
			pinned ?? randomUUID(),
		);
		const id = z
			.uuid()
			.parse(db.prepare("SELECT id FROM server WHERE singleton=1").get()?.id);
		if (pinned && pinned !== id)
			throw new ManagementError(
				409,
				"wrong_server",
				"The saved server identity differs from the installed host.",
			);
		return id;
	});
}

export function configureTopic(
	state: string,
	route: TopicRuntime,
	kind: (typeof profileKinds)[number],
	environment: string | null,
) {
	catalog(state, (db) =>
		db
			.prepare(
				"INSERT OR REPLACE INTO defaults(repoId,kind,environment) VALUES(?,?,?)",
			)
			.run(route.topic.repoId, kind, environment),
	);
	route.topic.defaultEnvironment = environment ?? undefined;
	route.topic.defaultClass = kind;
}

interface Binding {
	repoId: number;
	repository: string;
	installation: number;
	accountId?: number;
}
async function attach(
	state: string,
	routes: Map<string, TopicRuntime>,
	binding: Binding,
) {
	const key = topicKey(binding.installation, binding.repoId);
	for (const [existingKey, route] of routes) {
		if (
			route.topic.repoId !== binding.repoId &&
			route.topic.repository.toLowerCase() !== binding.repository.toLowerCase()
		)
			continue;
		if (existingKey !== key || route.topic.repository !== binding.repository)
			throw new ManagementError(
				409,
				"topic_conflict",
				"Repository placement changed. Reconcile the registered topic before continuing.",
			);
		return { route, added: false };
	}
	const saved = catalog(state, (db) =>
		db
			.prepare("SELECT directory FROM project_locations WHERE repoId=?")
			.get(binding.repoId),
	);
	const directory = saved
		? String(saved.directory)
		: join(state, "projects", repositoryName.parse(binding.repository));
	const route = await openTopic(directory, {
		repoId: binding.repoId,
		repository: binding.repository,
		installation: binding.installation,
		cwd: join(directory, "leo"),
	});
	routes.set(key, route);
	return { route, added: true };
}

export function pausedRepositories(state: string): Set<number> {
	return catalog(
		state,
		(db) =>
			new Set(
				db
					.prepare("SELECT repoId FROM project_locations WHERE paused=1")
					.all()
					.map((row) => Number(row.repoId)),
			),
	);
}

export async function restoreManagedTopics(
	state: string,
	routes: Map<string, TopicRuntime>,
) {
	for (const [key, route] of routes) {
		const paused = catalog(
			state,
			(db) =>
				db
					.prepare("SELECT paused FROM project_locations WHERE repoId=?")
					.get(route.topic.repoId)?.paused === 1,
		);
		if (paused) {
			routes.delete(key);
			route.journal.db.close();
		}
	}
	const { projects, defaults } = catalog(state, (db) => ({
		projects: db
			.prepare(
				"SELECT p.repoId,p.repository,p.installation FROM projects p LEFT JOIN project_locations l USING(repoId) WHERE COALESCE(l.paused,0)=0",
			)
			.all(),
		defaults: db.prepare("SELECT repoId,kind,environment FROM defaults").all(),
	}));
	for (const row of projects)
		await attach(state, routes, {
			repoId: Number(row.repoId),
			repository: String(row.repository),
			installation: Number(row.installation),
		});
	for (const row of defaults) {
		const route = Array.from(routes.values()).find(
			(r) => r.topic.repoId === row.repoId,
		);
		if (route) {
			route.topic.defaultClass = workClass.parse(row.kind);
			route.topic.defaultEnvironment =
				typeof row.environment === "string" ? row.environment : undefined;
		}
	}
}

type Inspector = (repo: string, installation: number) => Promise<Binding>;
export function projectConnector(
	state: string,
	routes: Map<string, TopicRuntime>,
	onAdded: (route: TopicRuntime) => void,
	inspect: Inspector = inspectProject,
	onRemoved: (route: TopicRuntime) => Promise<void> = async () => {},
	gate: (repository: string, paused: boolean) => Promise<void> = async () => {},
) {
	let update = Promise.resolve();
	const serial = <T>(operation: () => Promise<T>) => {
		const work = update.then(operation);
		update = work.then(
			() => {},
			() => {},
		);
		return work;
	};
	const connect = (
		uri: string,
		installation: number,
		expected?: { repoId: number; accountId: number },
	) =>
		serial(async () => {
			const requested = sourceUri
				.parse(uri)
				.slice("https://github.com/".length);
			let binding: Binding;
			try {
				binding = await inspect(requested, installation);
			} catch {
				throw new ManagementError(
					403,
					"installation_unavailable",
					"Verify the GitHub App installation and repository Issues write access.",
				);
			}
			if (
				expected &&
				(binding.repoId !== expected.repoId ||
					binding.accountId !== expected.accountId)
			)
				throw new ManagementError(
					409,
					"repository_changed",
					"Signed GitHub grant differs from the current repository or account.",
				);
			if (
				binding.repository.toLowerCase() !== requested.toLowerCase() ||
				binding.installation !== installation ||
				!Number.isSafeInteger(binding.repoId) ||
				binding.repoId < 1
			)
				throw new ManagementError(
					409,
					"repository_changed",
					"GitHub returned a different repository identity.",
				);
			{
				// Store the desired binding before activating it. Restart replays this operation.
				catalog(state, (db) => {
					const old = db
						.prepare("SELECT * FROM projects WHERE repoId=? OR repository=?")
						.all(binding.repoId, binding.repository);
					if (
						old.some(
							(r) =>
								r.repoId !== binding.repoId ||
								r.repository !== binding.repository ||
								r.installation !== binding.installation,
						)
					)
						throw new ManagementError(
							409,
							"topic_conflict",
							"Stored repository binding conflicts with GitHub.",
						);
					for (const { topic } of routes.values()) {
						if (
							topic.repoId === binding.repoId ||
							topic.repository.toLowerCase() ===
								binding.repository.toLowerCase()
						) {
							if (
								topic.repoId !== binding.repoId ||
								topic.repository !== binding.repository ||
								topic.installation !== binding.installation
							)
								throw new ManagementError(
									409,
									"topic_conflict",
									"Configured topic conflicts with GitHub.",
								);
							return; // Existing installer-owned topics retain their original state directory.
						}
					}
					db.prepare(
						"INSERT OR IGNORE INTO projects(repoId,repository,installation) VALUES(?,?,?)",
					).run(binding.repoId, binding.repository, binding.installation);
				});
				await gate(binding.repository, false);
				const { route, added } = await attach(state, routes, binding);
				catalog(state, (db) => {
					db.prepare(
						"INSERT INTO project_locations(repoId,repository,installation,directory) VALUES(?,?,?,?) ON CONFLICT(repoId) DO UPDATE SET paused=0",
					).run(binding.repoId, binding.repository, installation, route.state);
					const settings = db
						.prepare("SELECT kind,environment FROM defaults WHERE repoId=?")
						.get(binding.repoId);
					if (settings) {
						route.topic.defaultClass = workClass.parse(settings.kind);
						route.topic.defaultEnvironment =
							typeof settings.environment === "string"
								? settings.environment
								: undefined;
					}
				});
				if (added) onAdded(route);
				return route;
			}
		});
	const revoke = (
		installation: number,
		repoId: number,
		absent: () => Promise<boolean>,
	) =>
		serial(async () => {
			const key = topicKey(installation, repoId),
				route = routes.get(key);
			if (!route || !(await absent())) return false;
			await gate(route.topic.repository, true);
			catalog(state, (db) =>
				db
					.prepare(
						"INSERT INTO project_locations VALUES(?,?,?,?,1) ON CONFLICT(repoId) DO UPDATE SET paused=1",
					)
					.run(repoId, route.topic.repository, installation, route.state),
			);
			routes.delete(key);
			await onRemoved(route);
			route.journal.db.close();
			return true;
		});
	return Object.assign(connect, { revoke });
}
