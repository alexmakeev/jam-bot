import { exchange } from "./profile-checkout.js";
import { join } from "node:path";
import type { Topic } from "./intake-journal.js";
import { atomicJson, readJson } from "./storage.js";

const login = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const sha = /^[a-f0-9]{40}$/;
export interface ProjectValues {
	markdown: string;
	responsibilities: { area: string; role: string; login: string }[];
	owner: string;
	revision: string;
}
export function responsibilities(
	markdown: string,
): ProjectValues["responsibilities"] {
	const rows: ProjectValues["responsibilities"] = [];
	let section = false;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^#{1,6}\s/.test(line)) {
			section = /^## Responsibilities\s*$/i.test(line);
			continue;
		}
		if (!section || !line.trim() || !line.trimStart().startsWith("|")) continue;
		const cells = line
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((s) => s.trim());
		if (
			cells[0]?.toLowerCase() === "area" ||
			cells.every((s) => /^:?-+:?$/.test(s))
		)
			continue;
		const [area, role, handle] = cells;
		if (
			cells.length !== 3 ||
			!area ||
			area.length > 80 ||
			!role ||
			role.length > 80 ||
			!handle?.startsWith("@") ||
			!login.test(handle.slice(1))
		)
			throw Error("Invalid VALUES.md responsibility");
		if (rows.some((r) => r.area === area.toLowerCase()))
			throw Error("Ambiguous VALUES.md responsibility");
		rows.push({ area: area.toLowerCase(), role, login: handle.slice(1) });
	}
	return rows;
}
export function responsible(profile: ProjectValues, area: string) {
	return (
		profile.responsibilities.find((row) => row.area === area.toLowerCase())
			?.login ??
		profile.responsibilities.find((row) => row.area === "project lead")
			?.login ??
		profile.owner
	);
}
export async function loadProjectValues(
	topic: Topic,
	signal = AbortSignal.timeout(240000),
): Promise<ProjectValues> {
	const result = await exchange(
		join(topic.cwd, "project.git"),
		{ repo: topic.repository, repoId: topic.repoId, action: "project-profile" },
		signal,
	);
	if (
		!sha.test(result.sha) ||
		typeof result.markdown !== "string" ||
		!login.test(result.owner ?? "")
	)
		throw Error("Invalid project profile reply");
	return {
		markdown: result.markdown,
		revision: result.sha,
		responsibilities: responsibilities(result.markdown),
		owner: result.owner!,
	};
}
const path = (state: string, issue: number) =>
	join(state, "assignments", String(issue), "project-values.json");
export async function refreshProjectValues(
	topic: Topic,
	state: string,
	issues: number | number[],
	signal?: AbortSignal,
) {
	const profile = await loadProjectValues(topic, signal);
	await Promise.all(
		(Array.isArray(issues) ? issues : [issues]).map((issue) =>
			atomicJson(path(state, issue), profile),
		),
	);
	return profile;
}
export async function profileContext(state: string, issue: number) {
	const profile = await readJson<ProjectValues>(path(state, issue)).catch(
		(e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") throw e;
		},
	);
	return profile?.markdown ?? "";
}
