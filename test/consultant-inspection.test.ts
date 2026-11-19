import test from "node:test";
import assert from "node:assert/strict";
import {
	requireWorkspaceInspection,
	workspaceInspectionEvent,
	type WorkspaceInspection,
	type Advice,
} from "../src/profile-checkout.js";
test("successful advice requires named direct code and positive index reads from both pinned identities", () => {
	const identity = { revision: "a".repeat(40), specifications: "b".repeat(64) };
	const adviser = { name: "Codex Low", provider: "codex", model: "selected" };
	const advice: Advice[] = [{ ...adviser, status: "ok", text: "review" }];
	const inspection: WorkspaceInspection = {
		...identity,
		readers: [
			{
				reader: "fixture",
				adviser,
				identity,
				observed: 2,
				events: [
					{
						operation: "read",
						root: "repository",
						path: "src/code.ts",
						bytes: 20,
					},
					{
						operation: "read",
						root: "specifications",
						path: "index.json",
						bytes: 2,
					},
				],
			},
		],
	};
	const validate = (value: WorkspaceInspection | undefined) =>
		requireWorkspaceInspection(
			value,
			identity.revision,
			identity.specifications,
			advice,
		);
	validate(inspection);
	assert.throws(() => validate(undefined));
	assert.throws(() => validate({ ...inspection, readers: [] }));
	for (const mutate of [
		(value: WorkspaceInspection) => {
			value.readers[0]!.adviser.name = "Other";
		},
		(value: WorkspaceInspection) => {
			value.readers[0]!.identity.specifications = "c".repeat(64);
		},
		(value: WorkspaceInspection) => {
			value.readers[0]!.events[0]!.operation = "search-scan";
		},
		(value: WorkspaceInspection) => {
			value.readers[0]!.events[1]!.bytes = 0;
		},
	]) {
		const changed = structuredClone(inspection);
		mutate(changed);
		assert.throws(() => validate(changed));
	}
});
test("workspace discovery and denied calls are valid control events but cannot stand in for reads", () => {
	const details = { root: "repository", path: "", bytes: 0 };
	for (const operation of ["tools-list", "rejected-call"]) {
		assert.deepEqual(workspaceInspectionEvent({ operation, ...details }), {
			operation,
			...details,
		});
		assert.throws(
			() => workspaceInspectionEvent({ operation, ...details, bytes: 1 }),
			/control event/,
		);
		assert.throws(
			() =>
				workspaceInspectionEvent({
					operation,
					...details,
					path: "src/index.ts",
				}),
			/control event/,
		);
	}
	assert.throws(
		() =>
			workspaceInspectionEvent({
				operation: "read",
				...details,
				path: "../other",
			}),
		/inspection event/,
	);
});
