import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appReader, issueClient } from "./github-app.js";
import { exchange, git } from "./profile-checkout.js";
import { readJson } from "./storage.js";
import type { Topic } from "./intake-journal.js";

const sha = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const number = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
type Dependency = { issue: number; id: number };
type Read = (path: string) => Promise<unknown>;
type Write = (path: string, method: string, body: object) => Promise<unknown>;

export class DependencyHold extends Error {
	issue?: number;
}
export class DependencyTaskWithdrawn extends Error {}

function dependency(raw: unknown, repository: string): Dependency {
	const issue = raw as {
		number?: unknown;
		id?: unknown;
		repository_url?: unknown;
		pull_request?: unknown;
	} | null;
	if (
		!issue ||
		!number(issue.number) ||
		!number(issue.id) ||
		issue.pull_request ||
		typeof issue.repository_url !== "string" ||
		issue.repository_url.toLowerCase() !==
			("https://api.github.com/repos/" + repository).toLowerCase()
	)
		throw new DependencyHold(
			"Issue dependency is outside this repository or has unknown identity.",
		);
	return { issue: issue.number, id: issue.id };
}

export async function nativeDependencies(
	read: Read,
	repository: string,
	issue: number,
) {
	const records = new Map<number, Dependency>();
	for (let page = 1; page <= 5; page++) {
		const data = await read(
			"/issues/" + issue + "/dependencies/blocked_by?per_page=100&page=" + page,
		);
		if (!Array.isArray(data) || data.length > 100)
			throw Error("Incomplete GitHub dependency page");
		for (const item of data) {
			const edge = dependency(item, repository);
			if (
				records.has(edge.issue) ||
				[...records.values()].some((known) => known.id === edge.id)
			)
				throw Error("Conflicting GitHub dependency pages");
			records.set(edge.issue, edge);
		}
		if (data.length < 100) return [...records.values()];
	}
	throw new DependencyHold(
		"Issue dependency graph exceeds the supported size.",
	);
}

export async function checkDependencyGraph({
	read,
	write,
	repository,
	issue,
	expected = [],
	authorize,
	integrated,
	claim,
	confirm,
}: {
	read: Read;
	write: Write;
	repository: string;
	issue: number;
	expected?: number[];
	authorize: () => Promise<void>;
	integrated: (edge: Dependency) => Promise<string | undefined>;
	claim?: (edge: Dependency) => boolean;
	confirm?: (edge: Dependency) => void;
}) {
	let direct = await nativeDependencies(read, repository, issue);
	const required = new Map<number, Dependency>();
	for (const blocker of expected) {
		if (blocker === issue)
			throw new DependencyHold("Issue dependency cycle at #" + issue + ".");
		required.set(
			blocker,
			dependency(await read("/issues/" + blocker), repository),
		);
		if (required.get(blocker)?.issue !== blocker)
			throw Error("Blocking issue identity changed");
	}
	const known = new Map<number, number>();
	const checked = new Set<number>();
	const visit = async (edge: Dependency, path: number[]) => {
		if (path.includes(edge.issue))
			throw new DependencyHold(
				"Issue dependency cycle " +
					[...path, edge.issue].map((id) => "#" + id).join(" → ") +
					".",
			);
		if (known.has(edge.issue) && known.get(edge.issue) !== edge.id)
			throw Error("Blocking issue identity changed");
		known.set(edge.issue, edge.id);
		if (known.size > 200)
			throw new DependencyHold(
				"Issue dependency graph exceeds the supported size.",
			);
		if (checked.has(edge.issue)) return;
		for (const parent of await nativeDependencies(read, repository, edge.issue))
			await visit(parent, [...path, edge.issue]);
		checked.add(edge.issue);
	};
	for (const edge of [...direct, ...required.values()])
		await visit(edge, [issue]);
	for (const [blocker, edge] of required) {
		const previouslyConfirmed = claim?.(edge);
		if (direct.some((item) => item.issue === blocker && item.id === edge.id)) {
			confirm?.(edge);
			continue;
		}
		if (previouslyConfirmed)
			throw new DependencyHold(
				"Approved dependency #" +
					blocker +
					" was removed. Reconcile the work card scope.",
			);
		await authorize();
		const suffix = "/issues/" + issue + "/dependencies/blocked_by";
		try {
			await write(suffix, "POST", { issue_id: edge.id });
		} catch (error) {
			direct = await nativeDependencies(read, repository, issue);
			if (!direct.some((item) => item.issue === blocker && item.id === edge.id))
				throw error;
		}
		direct = await nativeDependencies(read, repository, issue);
		if (!direct.some((item) => item.issue === blocker && item.id === edge.id))
			throw Error("GitHub dependency write requires reconciliation");
		confirm?.(edge);
	}
	for (const edge of direct) await visit(edge, [issue]);
	const revisions = [];
	for (const edge of direct) {
		const revision = await integrated(edge);
		if (!revision)
			throw new DependencyHold(
				"Waiting for verified dev integration of #" + edge.issue + ".",
			);
		revisions.push(revision);
	}
	return revisions;
}

export const usesDependencies = (topic: Topic) =>
	(process.env.JAM_DEVELOPMENT_V2_REPOSITORIES ?? "")
		.split(",")
		.map((name) => name.trim())
		.includes(topic.repository);

export async function verifyDependencyPublication(
	state: string,
	repository: string,
	db: DatabaseSync,
	issue: number,
	currentDev: () => Promise<string | undefined>,
	base?: string,
) {
	const member = db
		.prepare(`SELECT b.id,m.sha FROM integration_members m JOIN integration_batches b ON m.batch=b.id
      WHERE b.state='integrated' AND m.issue=? ORDER BY b.rowid DESC LIMIT 1`)
		.get(issue);
	if (
		!member ||
		!sha(member.sha) ||
		typeof member.id !== "string" ||
		!/^[a-f0-9-]{36}$/.test(member.id)
	)
		return;
	const directory = join(state, "integration", member.id);
	const optional = async <T>(path: string) =>
		readJson<T>(path).catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
	const [candidate, published, intent] = await Promise.all([
		optional<{ sha?: string }>(join(directory, "candidate.json")),
		optional<{ sha?: string }>(join(directory, "published.json")),
		optional<{
			action?: string;
			sha?: string;
			repo?: string;
			cards?: { issue: number }[];
		}>(join(directory, "publication-intent.json")),
	]);
	if (
		!sha(candidate?.sha) ||
		published?.sha !== candidate.sha ||
		intent?.sha !== candidate.sha ||
		intent.action !== "publish" ||
		intent.repo !== repository ||
		!intent.cards?.some((card) => card.issue === issue)
	)
		return;
	const store = join(state, "project.git");
	const dev = await currentDev();
	if (
		!sha(dev) ||
		(await git(store, "merge-base", member.sha, candidate.sha)) !==
			member.sha ||
		(await git(store, "merge-base", candidate.sha, dev)) !== candidate.sha
	)
		return;
	if (
		base &&
		(await git(store, "merge-base", candidate.sha, base)) !== candidate.sha
	)
		throw new DependencyHold(
			"Checkout base must be reconciled with integrated prerequisite #" +
				issue +
				".",
		);
	return candidate.sha;
}

export async function verifyDependencies(
	state: string,
	topic: Topic,
	db: DatabaseSync,
	issue: number,
	signal: AbortSignal,
	authorize: () => Promise<void>,
	expected?: number[],
	base?: string,
) {
	if (!usesDependencies(topic)) return;
	const read = await appReader(topic.repository, String(topic.installation));
	const repository = "repos/" + topic.repository;
	if ((await read(repository)).id !== topic.repoId)
		throw Error("Dependency repository identity changed");
	const subject = await read(repository + "/issues/" + issue);
	if (dependency(subject, topic.repository).issue !== issue)
		throw Error("Dependent issue identity changed");
	if (subject.state === "closed" && subject.state_reason === "not_planned")
		throw new DependencyTaskWithdrawn("Verified GitHub withdrawal before work");
	let writer: Awaited<ReturnType<typeof issueClient>> | undefined;
	const store = join(state, "project.git");
	let current: Promise<string | undefined> | undefined;
	const integrated = async (edge: Dependency) => {
		const source = dependency(
			await read(repository + "/issues/" + edge.issue),
			topic.repository,
		);
		if (source.id !== edge.id || source.issue !== edge.issue) return;
		return verifyDependencyPublication(
			state,
			topic.repository,
			db,
			edge.issue,
			() => {
				current ??= exchange(
					store,
					{ action: "seed", repo: topic.repository },
					signal,
				).then((result) => result.dev);
				return current;
			},
			base,
		);
	};
	return checkDependencyGraph({
		read: (path) => read(repository + path),
		write: async (path, method, body) => {
			writer ??= await issueClient(topic.repository, topic.installation);
			return writer(path, method, body);
		},
		repository: topic.repository,
		issue,
		expected,
		authorize,
		integrated,
		claim(edge) {
			db.prepare("INSERT OR IGNORE INTO dependency_claims VALUES(?,?,?,0)").run(
				issue,
				edge.issue,
				edge.id,
			);
			const saved = db
				.prepare(
					"SELECT githubId,confirmed FROM dependency_claims WHERE issue=? AND blocker=?",
				)
				.get(issue, edge.issue);
			if (saved?.githubId !== edge.id)
				throw new DependencyHold(
					"Approved dependency #" + edge.issue + " changed identity.",
				);
			return saved?.confirmed === 1;
		},
		confirm(edge) {
			db.prepare(
				"UPDATE dependency_claims SET confirmed=1 WHERE issue=? AND blocker=? AND githubId=?",
			).run(issue, edge.issue, edge.id);
		},
	});
}
