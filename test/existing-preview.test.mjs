import assert from "node:assert/strict";
import test from "node:test";
import { observeExistingPreview } from "../scripts/macos/existing-preview.mjs";

test("existing preview probes exact approved destinations, does not follow redirects, and inspects only its pinned dependency", async () => {
	const recipe = {
		web: { port: 5173, path: "/" },
		api: { port: 3000, path: "/health" },
		docker: { project: "example-preview", service: "db" },
	};
	const container = "f".repeat(64),
		seen = [];
	const cli = async (args) => {
		seen.push(args);
		return args[0] === "ps" ? container : "true healthy";
	};
	const http = async (url, options) => {
		assert.equal(options.redirect, "manual");
		return new Response(null, { status: url.endsWith("/health") ? 302 : 200 });
	};
	const result = await observeExistingPreview("local", recipe, cli, http);
	assert.equal(result.running, true);
	assert.equal(result.healthy, false);
	assert.equal(result.observation.api.status, 302);
	assert.equal(result.observation.dependency.containerId, container);
	assert.deepEqual(
		seen.map((args) => args[0]),
		["ps", "inspect"],
	);
	assert.ok(seen[0].includes("label=com.docker.compose.service=db"));
	await assert.rejects(
		observeExistingPreview(
			"local",
			{ web: { port: 5173, path: "//example.com" } },
			cli,
			http,
		),
	);
	await assert.rejects(
		observeExistingPreview(
			"local",
			recipe,
			async () => container + "\n" + container,
			http,
		),
		/ambiguous/,
	);
	const stopped = await observeExistingPreview(
		"local",
		{ web: recipe.web },
		cli,
		async () => {
			throw Error("Offline");
		},
	);
	assert.equal(stopped.running, false);
	assert.equal(stopped.observation.web.status, null);
});
