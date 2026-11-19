import test from "node:test";
import assert from "node:assert/strict";
import { checkCurrentRole } from "../src/github-authorization.js";
test("live role decision rejects revoked grants, renamed identities and base-write ambiguity", () => {
	const actor = { id: 42, login: "maintainer", type: "User" };
	const repo = { owner: { type: "Organization", id: 100 } };
	const permission = {
		user: actor,
		role_name: "maintain",
		permission: "write",
	};
	checkCurrentRole(actor, repo, permission);
	assert.throws(() =>
		checkCurrentRole(actor, repo, { ...permission, role_name: "write" }),
	);
	assert.throws(() =>
		checkCurrentRole(actor, repo, { ...permission, role_name: "none" }),
	);
	assert.throws(() =>
		checkCurrentRole(actor, repo, {
			...permission,
			user: { ...actor, id: 43 },
		}),
	);
	assert.throws(() =>
		checkCurrentRole({ ...actor, type: "Bot" }, repo, permission),
	);
	const personal = { owner: actor };
	checkCurrentRole(actor, personal, { ...permission, role_name: "admin" });
	assert.throws(() =>
		checkCurrentRole(
			actor,
			{ owner: { ...actor, id: 100 } },
			{ ...permission, role_name: "admin" },
		),
	);
});
