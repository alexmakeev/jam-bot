import { appReader } from "./github-app.js";
import { execFileSync } from "node:child_process";

export interface GitHubActor {
	id: number;
	login: string;
	type: string;
}
export function github(path: string): any {
	return JSON.parse(
		execFileSync("gh", ["api", "--hostname", "github.com", path], {
			encoding: "utf8",
			timeout: 15_000,
		}),
	);
}
export function checkCurrentRole(
	actor: GitHubActor,
	repository: any,
	permission: any,
): void {
	if (
		!Number.isSafeInteger(actor.id) ||
		actor.id <= 0 ||
		actor.type !== "User" ||
		permission.user?.id !== actor.id ||
		permission.user?.type !== "User"
	)
		throw new Error("GitHub approver identity could not be verified");
	const owner = repository.owner;
	const allowed =
		owner?.type === "User"
			? owner.id === actor.id && permission.role_name === "admin"
			: owner?.type === "Organization" &&
				["maintain", "admin"].includes(permission.role_name);
	if (!allowed)
		throw new Error(
			"GitHub approver no longer has the required repository role",
		);
}
export async function authorizeGitHubIssue(
	url: string,
	actor: GitHubActor,
): Promise<void> {
	const match =
		/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/[1-9]\d*$/.exec(url);
	if (!match || !/^[a-zA-Z0-9-]+$/.test(actor.login))
		throw new Error("Invalid GitHub approval reference");
	const path = "repos/" + match[1] + "/" + match[2];
	const read = await appReader(match[1] + "/" + match[2]);
	const repository = await read(path);
	const permission = await read(
		path + "/collaborators/" + encodeURIComponent(actor.login) + "/permission",
	);
	checkCurrentRole(actor, repository, permission);
}
