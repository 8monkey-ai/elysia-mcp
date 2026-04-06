/**
 * Elysia MCP Plugin
 *
 * Auto-discovers routes with `detail: { mcp: true }` and exposes them as MCP
 * tools via a POST endpoint handling the MCP JSON-RPC protocol.
 *
 * Uses `app.handle()` for tool invocation — every MCP tool call goes through
 * the full Elysia lifecycle (derive, resolve, beforeHandle, afterHandle, error
 * hooks, and all plugins).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { Elysia } from "elysia";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { deriveToolName } from "./naming.js";
import { flattenSchemas, unflattenArgs } from "./schema.js";
import type { FlattenResult } from "./schema.js";
import { toMcpContent } from "./unwrap.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface McpPluginOptions {
	/** MCP server name (default: "elysia-mcp") */
	name?: string;
	/** MCP server version (default: "1.0.0") */
	version?: string;
	/** Endpoint path (default: "/mcp") */
	path?: string;
}

export interface McpToolMeta {
	name?: string;
	description?: string;
}

/** Shape of `detail.mcp` — either `true` or an override object */
export type McpDetailValue = true | McpToolMeta;

interface DiscoveredTool {
	name: string;
	description: string;
	method: string;
	path: string;
	flatten: FlattenResult;
}

// ─── AsyncLocalStorage for per-request context ───────────────────────

interface McpRequestContext {
	/** The original incoming Request to the MCP endpoint */
	request: Request;
}

const mcpContext = new AsyncLocalStorage<McpRequestContext>();

// ─── Route Discovery ─────────────────────────────────────────────────

function discoverTools(app: Elysia): DiscoveredTool[] {
	const tools: DiscoveredTool[] = [];
	const routes = app.routes;

	for (const route of routes) {
		const detail = route.hooks?.detail as Record<string, unknown> | undefined;
		if (!detail?.["mcp"]) continue;

		const mcpMeta = detail["mcp"] as McpDetailValue;
		const method = route.method.toUpperCase();
		const routePath = route.path;

		const name =
			typeof mcpMeta === "object" && mcpMeta.name
				? mcpMeta.name
				: deriveToolName(method, routePath);

		const description =
			(typeof mcpMeta === "object" && mcpMeta.description) ||
			(detail["summary"] as string | undefined) ||
			`${method} ${routePath}`;

		const flatten = flattenSchemas(name, {
			params: route.hooks?.params,
			query: route.hooks?.query,
			body: route.hooks?.body,
		});

		for (const warning of flatten.warnings) {
			console.warn(warning);
		}

		tools.push({ name, description, method, path: routePath, flatten });
	}

	return tools;
}

// ─── Build synthetic Request for app.handle() ────────────────────────

function buildRequest(
	tool: DiscoveredTool,
	args: Record<string, unknown>,
	originalRequest: Request,
): Request {
	const { params, query, body } = unflattenArgs(args, tool.flatten.origins);

	// Substitute path parameters
	let resolvedPath = tool.path;
	for (const [key, value] of Object.entries(params)) {
		resolvedPath = resolvedPath.replace(`:${key}`, encodeURIComponent(String(value)));
	}

	// Build query string
	const queryEntries = Object.entries(query).filter(([, v]) => v != null);
	const qs = queryEntries.length > 0
		? `?${new URLSearchParams(queryEntries.map(([k, v]) => [k, String(v)])).toString()}`
		: "";

	const origin = new URL(originalRequest.url).origin;
	const url = `${origin}${resolvedPath}${qs}`;

	// Copy headers from the original MCP request (auth, cookies, etc.)
	const headers = new Headers(originalRequest.headers);

	const method = tool.method;
	const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";

	// Sanitize content headers — the original values correspond to the
	// JSON-RPC payload, not the synthetic request's body.
	headers.delete("content-length");
	if (!hasBody || Object.keys(body).length === 0) {
		headers.delete("content-type");
	} else {
		headers.set("content-type", "application/json");
	}
	const bodyContent = hasBody && Object.keys(body).length > 0
		? JSON.stringify(body)
		: undefined;

	return new Request(url, {
		method,
		headers,
		body: bodyContent,
	});
}

// ─── Create MCP Server with tool handlers (reused across requests) ───

function createMcpServer(
	serverName: string,
	serverVersion: string,
	toolMap: Map<string, DiscoveredTool>,
	rootApp: Elysia,
): Server {
	const server = new Server(
		{ name: serverName, version: serverVersion },
		{ capabilities: { tools: {} } },
	);

	const toolListResponse = {
		tools: [...toolMap.values()].map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.flatten.schema,
		})),
	};

	server.setRequestHandler(ListToolsRequestSchema, () => toolListResponse);

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const toolName = request.params.name;
		const tool = toolMap.get(toolName);

		if (!tool) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
			};
		}

		const args = (request.params.arguments ?? {}) as Record<string, unknown>;

		const ctx = mcpContext.getStore();
		if (!ctx) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: "Internal error: missing MCP request context" }],
			};
		}

		// Build a synthetic request and run through the full Elysia lifecycle
		const syntheticRequest = buildRequest(tool, args, ctx.request);
		const response = await rootApp.handle(syntheticRequest) as Response;

		let data: unknown;
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			data = await response.json();
		} else {
			data = await response.text();
		}

		if (!response.ok) {
			return {
				isError: true,
				...toMcpContent(data),
			};
		}

		return toMcpContent(data);
	});

	return server;
}

// ─── Plugin ──────────────────────────────────────────────────────────

/**
 * Create the Elysia MCP plugin.
 *
 * Usage:
 * ```typescript
 * const app = new Elysia()
 *   .get("/users", handler, { detail: { mcp: true } })
 *   .use(mcp({ name: "my-api", version: "1.0.0" }));
 * ```
 *
 * **Important:** `.use(mcp())` must come after all MCP-eligible routes are
 * registered, as route discovery happens at plugin mount time.
 */
export function mcp(options: McpPluginOptions = {}) {
	const {
		name = "elysia-mcp",
		version = "1.0.0",
		path = "/mcp",
	} = options;

	// Return a function-style plugin to capture the parent Elysia app reference.
	// This gives us access to app.routes (for discovery) and app.handle() (for
	// tool invocation through the full lifecycle).
	return (app: Elysia) => {
		const tools = discoverTools(app);

		// Build a Map for O(1) tool lookup by name
		const toolMap = new Map<string, DiscoveredTool>();
		for (const tool of tools) {
			if (toolMap.has(tool.name)) {
				console.warn(`[mcp] Duplicate tool name "${tool.name}" — later route will override`);
			}
			toolMap.set(tool.name, tool);
		}

		if (tools.length === 0) {
			console.warn("[mcp] No routes with detail.mcp found — MCP server will have no tools");
		} else {
			console.info(`[mcp] Discovered ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
		}

		// Create the MCP server once at startup — tool handlers and list
		// response are fixed for the lifetime of the app. Only the transport
		// is created per-request (stateless mode, no session tracking).
		const server = createMcpServer(name, version, toolMap, app);

		return app.post(path, async ({ request, body }: { request: Request; body: unknown }) => {
			return mcpContext.run({ request }, async () => {
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});

				await server.connect(transport);
				try {
					return await transport.handleRequest(request, {
						parsedBody: body,
					});
				} finally {
					await transport.close();
				}
			});
		});
	};
}
