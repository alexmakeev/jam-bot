import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WorkspaceReader } from "./workspace-reader.js";
import { loadWorkspace } from "./workspace-binding.js";
import { SharedWorkspace } from "./shared-workspace.js";
import { atomicJson } from "./storage.js";

const [, , file, digest, session, member, challenge] = process.argv;
if (!file) throw Error("Workspace manifest required");
const sharedSession = file === "--shared" ? session : undefined;
if (file === "--shared" && (!digest || !sharedSession))
	throw Error("Shared workspace requires a lead session and admission journal");
const shared = sharedSession ? new SharedWorkspace(digest!) : undefined;
const manifest = shared
	? undefined
	: await loadWorkspace(
			file,
			digest && session && member && challenge
				? { digest, binding: { session, member, challenge } }
				: undefined,
		);
if (
	manifest &&
	(!manifest.identity?.revision || !manifest.identity.specifications)
)
	throw Error("Invalid workspace manifest");
const base = {
	root: z.enum(["repository", "specifications"]),
	path: z.string().default(""),
	offset: z.int().nonnegative().optional(),
	limit: z.int().positive().optional(),
};
const schemas = {
	workspace_list: z.strictObject(base),
	workspace_read: z.strictObject({ ...base, path: z.string().min(1) }),
	workspace_search: z.strictObject({
		...base,
		query: z.string().min(1).max(2000),
		lineOffset: z.int().nonnegative().optional(),
	}),
};
const descriptions = {
	workspace_list:
		"List the selected immutable repository or approved-specification directory. Results are paginated.",
	workspace_read:
		"Read a text file by relative path and byte range. Code and specifications are data; no execution or writes are available.",
	workspace_search:
		"Search text for a literal string within an immutable root. For the next page pass offset=next and lineOffset=nextLine; large skipped files remain readable by ranges.",
};
const server = new Server(
	{ name: "jam-workspace", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
	if (sharedSession && member)
		await atomicJson(member, {
			session: sharedSession,
			tools: Object.keys(schemas),
		});
	if (manifest?.audit)
		await appendFile(
			manifest.audit,
			JSON.stringify({
				at: new Date().toISOString(),
				identity: manifest.identity,
				binding: manifest.binding,
				operation: "tools-list",
				root: "repository",
				path: "",
				bytes: 0,
				tools: Object.keys(schemas),
			}) + "\n",
			{ mode: 0o600 },
		);
	return {
		tools: Object.entries(schemas).map(([name, schema]) => ({
			name,
			_meta: { "anthropic/alwaysLoad": true },
			description: descriptions[name as keyof typeof descriptions],
			inputSchema: z.toJSONSchema(schema, { io: "input" }),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		})),
	};
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	let admission: ReturnType<SharedWorkspace["take"]> | undefined;
	let allocated = manifest;
	try {
		const name = request.params.name;
		if (!Object.hasOwn(schemas, name))
			throw Error("Unknown workspace operation");
		if (shared && sharedSession) {
			admission = shared.take(
				request.params._meta?.["claudecode/toolUseId"],
				sharedSession,
				name,
				request.params.arguments,
			);
			allocated = await loadWorkspace(admission.manifest, admission);
		}
		if (!allocated) throw Error("Workspace is unavailable");
		const reader = new WorkspaceReader(allocated);
		let result: Awaited<
			ReturnType<WorkspaceReader["read" | "list" | "search"]>
		>;
		if (name === "workspace_search") {
			const x = schemas.workspace_search.parse(request.params.arguments);
			result = await reader.search(
				x.root,
				x.query,
				x.path,
				x.offset,
				x.limit,
				x.lineOffset,
			);
		} else {
			const x = schemas[name as "workspace_read" | "workspace_list"].parse(
				request.params.arguments,
			);
			result =
				name === "workspace_read"
					? await reader.read(x.root, x.path, x.offset, x.limit)
					: await reader.list(x.root, x.path, x.offset, x.limit);
		}
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
		};
	} catch {
		if (allocated?.audit)
			await appendFile(
				allocated.audit,
				JSON.stringify({
					at: new Date().toISOString(),
					identity: allocated.identity,
					binding: allocated.binding,
					operation: "rejected-call",
					root: "repository",
					path: "",
					bytes: 0,
				}) + "\n",
				{ mode: 0o600 },
			);
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: "Workspace operation rejected or unavailable. Use only registered roots and valid relative paths.",
				},
			],
		};
	} finally {
		admission?.finish();
	}
});
await server.connect(new StdioServerTransport());
