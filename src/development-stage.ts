import { join } from "node:path";
import { atomicJson, readJson } from "./storage.js";
import type { createWorkspaceSnapshot } from "./workspace-snapshot.js";
type Workspace = Awaited<ReturnType<typeof createWorkspaceSnapshot>>;
interface StageInput {
	approvalDigest: string;
	input: string;
	workspace: Workspace;
}
export async function pinDevelopmentStage(
	state: string,
	issue: number,
	role: string,
	step: string,
	approvalDigest: string,
	input: string,
	create: () => Promise<Workspace>,
): Promise<StageInput> {
	if (
		!/^(architect|developer)$/.test(role) ||
		!/^[-a-z0-9]{1,100}$/.test(step) ||
		!Number.isSafeInteger(issue) ||
		issue < 1
	)
		throw Error("Invalid Development stage identity");
	const path = join(
		state,
		"assignments",
		String(issue),
		"stage-inputs",
		role + "-" + step + ".json",
	);
	const saved = await readJson<StageInput>(path).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		},
	);
	if (saved) {
		if (saved.approvalDigest !== approvalDigest)
			throw Error("Pinned stage approval changed");
		return saved;
	}
	const workspace = await create();
	input +=
		"\nPinned independent workspace identity: " +
		JSON.stringify(workspace.identity) +
		". Begin with index.json using the specifications root; inspect relevant code yourself. This snapshot supplements excerpts, which are not an exhaustive selection.";
	const value = { approvalDigest, input, workspace };
	await atomicJson(path, value);
	return value;
}
