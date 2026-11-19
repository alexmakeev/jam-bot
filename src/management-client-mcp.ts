import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// A local desktop client can use its named endpoint without distributing the owner
// credential to its launch environment. The remote server remains authoritative.
export async function serveNamedEndpoint(
	origin: string,
	tokenFile: string,
	serverId: string,
) {
	const token = (await readFile(tokenFile, "utf8")).trim();
	const client = new Client({ name: "jam-bot-named-client", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("/mcp", origin), {
			requestInit: {
				headers: { authorization: "Bearer " + token },
				redirect: "error",
			},
		}),
	);
	const server = new Server(
		{ name: "jam-bot", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, (request) =>
		client.listTools(request.params),
	);
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const target = request.params.arguments?.serverId;
		if (target !== undefined && target !== serverId)
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "Selected target differs from the pinned server.",
					},
				],
			};
		return client.callTool(request.params, undefined, {
			signal: extra.signal,
			timeout: 180000,
		});
	});
	server.onclose = () => {
		void client.close();
	};
	try {
		await server.connect(new StdioServerTransport());
	} catch (error) {
		await client.close();
		throw error;
	}
}
