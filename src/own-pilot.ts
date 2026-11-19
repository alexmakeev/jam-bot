import type { TopicRuntime } from "./topics.js";

export function ownPilotIssue(route: TopicRuntime) {
	if (route.topic.repository !== "alexmakeev/jam-bot") return;
	const input = process.env.JAM_OWN_PILOT_ISSUE;
	if (input === undefined || input === "") return;
	const issue = Number(input);
	if (
		route.topic.repoId !== 1456661011 ||
		!/^[1-9][0-9]*$/.test(input) ||
		!Number.isSafeInteger(issue)
	)
		throw Error("Invalid own-repository pilot binding");
	return issue;
}

export function verifyOwnPilotJournal(route: TopicRuntime) {
	const issue = ownPilotIssue(route);
	if (issue === undefined) return;
	const other = route.journal.db
		.prepare("SELECT 1 FROM intake WHERE action='task' AND issue<>? LIMIT 1")
		.get(issue);
	if (other)
		throw Error(
			"Own-repository pilot requires a journal bound to its first card",
		);
}
