// Acceptance instrumentation for Claude Code 2.1.325. This trace format is version-specific.
import { readFile } from "node:fs/promises";

interface Block {
	type: string;
	id?: string;
	name?: string;
	input?: { to?: string; content?: string; file_path?: string };
	tool_use_id?: string;
	content?: { type: string; text?: string }[];
}
interface Row {
	type: string;
	message?: { content: string | Block[] };
}

async function trace(path: string): Promise<Row[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	// The writer can be between writes on its last line.
	return text
		.slice(0, text.lastIndexOf("\n") + 1)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export async function checkpointAuthor(
	prefix: string,
	token: string,
	file: string,
	previous?: string,
) {
	const rows = await trace(prefix + ".jsonl");
	const blocks = rows.flatMap((row) =>
		Array.isArray(row.message?.content) ? row.message.content : [],
	);
	const spawns = blocks.filter(
		(block) => block.type === "tool_use" && block.name === "Agent",
	);
	if (spawns.length > 1) throw new Error("More than one native agent spawned");
	if (!spawns.length) return;
	const result = blocks.find(
		(block) =>
			block.type === "tool_result" && block.tool_use_id === spawns[0]?.id,
	);
	const id = JSON.stringify(result?.content ?? "").match(
		/agent_id: ([\w-]+)/,
	)?.[1];
	if (!id) return;
	if (previous && id !== previous)
		throw new Error("Native worker identity changed");
	if (
		previous &&
		!blocks.some((b) => b.name === "SendMessage" && b.input?.to === id)
	)
		return;
	const worker = await trace(prefix + "/subagents/agent-" + id + ".jsonl");
	const wrote = worker.some(
		(row) =>
			Array.isArray(row.message?.content) &&
			row.message.content.some(
				(block) =>
					block.name === "Write" &&
					block.input?.file_path?.endsWith("/evidence/" + file) &&
					block.input.content?.trim() === token,
			),
	);
	const acknowledged = rows.some(
		(row) =>
			row.type === "user" &&
			typeof row.message?.content === "string" &&
			row.message.content.includes(
				'<teammate-message teammate_id="developer"',
			) &&
			row.message.content.includes(token),
	);
	if (wrote && acknowledged) return id;
}
