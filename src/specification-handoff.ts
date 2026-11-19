// Local operator entry point. Neither the file path nor its bytes come from the caller.
import { configuredTopics } from "./topics.js";
import { prepareSpec, attachmentUrl } from "./specification-upload.js";
import { appReader } from "./github-app.js";
import { atomicJson } from "./storage.js";
import { join } from "node:path";

const [repo, number, url, commentId] = process.argv.slice(2);
const issue = Number(number);
const route = configuredTopics(process.env.JAM_STATE_DIR!).find(
	(r) => r.topic.repository === repo,
);
if (!route) throw Error("Repository is not managed by this service");
const read = await appReader(
	route.topic.repository,
	String(route.topic.installation),
);
const path = "repos/" + repo;
const [card, repository] = await Promise.all([
	read(path + "/issues/" + issue),
	read(path),
]);
if (
	repository.id !== route.topic.repoId ||
	card.pull_request ||
	!card.locked ||
	card.state !== "open" ||
	card.user?.id !== repository.owner.id ||
	!card.labels.some((l: { name: string }) => l.name === "status:planning")
) {
	throw Error("Expected the locked owner-authored card in planning");
}
const packet = await prepareSpec(route.state, issue);
if (!url) console.log(JSON.stringify(packet));
else {
	if (
		!commentId ||
		!/^[1-9]\d*$/.test(commentId) ||
		!Number.isSafeInteger(Number(commentId))
	)
		throw Error("Expected comment ID");
	const comment = await read(path + "/issues/comments/" + commentId);
	if (
		comment.issue_url !== card.url ||
		comment.user?.id !== repository.owner.id ||
		attachmentUrl(comment.body, packet.name) !== url
	)
		throw Error(
			"Published attachment does not match the expected issue and format",
		);
	await atomicJson(
		join(
			route.state,
			"assignments",
			number!,
			"attachments",
			packet.name + ".receipt.json",
		),
		{ url, commentId: Number(commentId), sha256: packet.digest },
	);
}
