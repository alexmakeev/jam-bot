import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionNotice } from "../src/connection-notice.js";
import { openTopic } from "../src/topics.js";

test("lost response, restart and regrant adopt one closed, bot-authored informational issue", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "notice-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const topic = {
		repoId: 5,
		repository: "team/example",
		installation: 12,
		cwd: join(root, "leo"),
	};
	let route = await openTopic(root, topic),
		posts = 0;
	const signal = new AbortController().signal,
		issues: any[] = [
			{
				user: { id: 99, type: "User" },
				body: "<!-- jam-bot:connection:v1:5 -->",
			},
		];
	const api =
		async () => async (path: string, method?: string, payload?: object) => {
			if (path === "")
				return {
					id: 5,
					full_name: topic.repository,
					has_issues: true,
					owner: { type: "Organization", login: "team" },
				};
			if (path.startsWith("/collaborators?"))
				return [
					{ type: "Bot", login: "fake" },
					{ type: "User", login: "fixture-owner" },
				];
			if (path.startsWith("/issues?state=all")) return issues;
			assert.equal(method, "POST");
			assert.deepEqual(Object.keys(payload!).sort(), ["body", "title"]);
			const issue = {
				...payload,
				body: (payload as any).body,
				state: "closed",
				user: { type: "Bot", id: 8 },
				number: 71,
				html_url: "https://github.com/team/example/issues/71",
			};
			assert.match(issue.body, /@fixture-owner/);
			assert.match(issue.body, /no default deployment environment/);
			issues.push(issue);
			posts++;
			throw Error("lost response");
		};
	const publish = () =>
		connectionNotice(route, signal, api, async () => ({
			id: 8,
			login: "jam[bot]",
		}));
	await assert.rejects(publish(), /lost response/);
	route.journal.db.close();
	route = await openTopic(root, topic);
	assert.equal(await publish(), true);
	assert.equal(await publish(), true);
	assert.equal(posts, 1);
	assert.deepEqual(route.journal.list(), []);
	route.journal.db.close();
});
