import { AsyncLocalStorage } from "node:async_hooks";
import { Elysia } from "elysia";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { generateToolName } from "./naming.js";
import {
	flattenSchemas,
	unflattenArgs,
	findMissingDescriptions,
	type JsonSchemaObject,
} from "./schema.js";
import { unwrapResponse, toMcpContent } from "./unwrap.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpPluginOptions {
	/** MCP server name (default: "elysia-mcp") */
	name?: string;
	/** MCP server version (default: "1.0.0") */
	version?: string;
	/** Endpoint path (default: "/mcp") */
	path?: string;
}

export interface McpDetailOverride {
	/** Explicit tool name */
	name?: string;
	/** Explicit tool description */
	description?: string;
}

/** Shape stored per discovered tool */
interface ToolEntry {
	name: string;
	description: string;
	inputSchema: JsonSchemaObject;
	sourceMap: Record<string, "params" | "query" | "body">;
	handler: (ctx: unknown) => unknown;
	method: string;
	path: string;
}

// ── AsyncLocalStorage for per-request Elysia context ─────────────────────────

interface ElysiaRequestContext {
	body: unknown;
	query: Record<string, unknown>;
	params: Record<string, unknown>;
	headers: Record<string, string | undefined>;
	request: Request;
	path: string;
	set: {
		headers: Record<string, string>;
		status?: number | string;
	};
	store: Record<string, unknown>;
	cookie: Record<string, unknown>;
}

const contextStorage = new AsyncLocalStorage<ElysiaRequestContext>();

// ── Route introspection ──────────────────────────────────────────────────────

interface InternalRoute {
	method: string;
	path: string;
	handler: (ctx: unknown) => unknown;
	hooks: {
		detail?: {
			summary?: string;
			description?: string;
			mcp?: boolean | McpDetailOverride;
		};
		params?: unknown;
		query?: unknown;
		body?: unknown;
	};
}

function discoverRoutes(app: Elysia): ToolEntry[] {
	// Access Elysia's internal route registry
	const routes = (app as unknown as { routes: InternalRoute[] }).routes;
	if (!routes || !Array.isArray(routes)) {
		console.warn("[elysia-mcp] Could not access app.routes — no tools will be registered");
		return [];
	}

	const tools: ToolEntry[] = [];
	const namesSeen = new Set<string>();

	for (const route of routes) {
		const detail = route.hooks?.detail;
		if (!detail?.mcp) continue;

		const mcpConfig = detail.mcp;

		// Determine tool name
		let toolName: string;
		let toolDescription: string;

		if (typeof mcpConfig === "object" && mcpConfig.name) {
			toolName = mcpConfig.name;
		} else {
			toolName = generateToolName(route.method, route.path);
		}

		if (typeof mcpConfig === "object" && mcpConfig.description) {
			toolDescription = mcpConfig.description;
		} else {
			toolDescription = detail.summary ?? detail.description ?? `${route.method} ${route.path}`;
		}

		// Warn on duplicate names
		if (namesSeen.has(toolName)) {
			console.warn(`[elysia-mcp] Duplicate tool name "${toolName}" — skipping ${route.method} ${route.path}`);
			continue;
		}
		namesSeen.add(toolName);

		// Flatten schemas
		const { schema, sourceMap, collisions } = flattenSchemas(
			route.hooks?.params,
			route.hooks?.query,
			route.hooks?.body,
		);

		// Warn on collisions
		if (collisions.length > 0) {
			console.warn(
				`[elysia-mcp] Tool "${toolName}": property name collision across params/query/body: ${collisions.join(", ")}`,
			);
		}

		// Warn on missing descriptions
		const missing = findMissingDescriptions(schema);
		if (missing.length > 0) {
			console.warn(
				`[elysia-mcp] Tool "${toolName}": parameters missing descriptions: ${missing.join(", ")}`,
			);
		}

		tools.push({
			name: toolName,
			description: toolDescription,
			inputSchema: schema,
			sourceMap,
			handler: route.handler,
			method: route.method,
			path: route.path,
		});
	}

	return tools;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function mcp(options: McpPluginOptions = {}) {
	const {
		name = "elysia-mcp",
		version = "1.0.0",
		path = "/mcp",
	} = options;

	let tools: ToolEntry[] = [];
	let initialized = false;

	/**
	 * Creates a fresh MCP Server instance with tool handlers registered.
	 * A new server+transport pair is needed per request in stateless mode.
	 */
	function createMcpServer(): Server {
		const server = new Server({ name, version }, { capabilities: { tools: {} } });

		server.setRequestHandler(ListToolsRequestSchema, () => ({
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			})),
		}));

		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const toolName = request.params.name;
			const tool = tools.find((t) => t.name === toolName);

			if (!tool) {
				return {
					content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
					isError: true,
				};
			}

			const args = (request.params.arguments ?? {}) as Record<string, unknown>;
			const { params, query, body } = unflattenArgs(args, tool.sourceMap);

			// Get the Elysia context from AsyncLocalStorage
			const elysiaCtx = contextStorage.getStore();

			// Build a context object for the handler
			const handlerCtx = {
				body: Object.keys(body).length > 0 ? body : elysiaCtx?.body,
				query: { ...elysiaCtx?.query, ...query },
				params: { ...elysiaCtx?.params, ...params },
				headers: elysiaCtx?.headers ?? {},
				request: elysiaCtx?.request ?? new Request("http://localhost"),
				path: tool.path,
				set: elysiaCtx?.set ?? { headers: {} },
				store: elysiaCtx?.store ?? {},
				cookie: elysiaCtx?.cookie ?? {},
			};

			try {
				const rawResult = await tool.handler(handlerCtx);
				const unwrapped = unwrapResponse(rawResult);
				return toMcpContent(unwrapped);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: message }],
					isError: true,
				};
			}
		});

		return server;
	}

	/**
	 * Handles an MCP request by creating a fresh server+transport pair per request.
	 */
	async function handleMcpRequest(request: Request): Promise<Response> {
		if (!initialized) {
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "MCP server not initialized" } }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});

		const server = createMcpServer();
		await server.connect(transport);

		const ctx: ElysiaRequestContext = {
			body: undefined,
			query: {},
			params: {},
			headers: Object.fromEntries(request.headers.entries()),
			request,
			path,
			set: { headers: {} },
			store: {},
			cookie: {},
		};

		const response = await contextStorage.run(ctx, () => transport.handleRequest(request));

		// Clean up: close the server after handling the request
		void server.close();

		return response;
	}

	return new Elysia({ name: "elysia-mcp" })
		.onStart((app) => {
			tools = discoverRoutes(app as unknown as Elysia);

			if (tools.length === 0) {
				console.warn("[elysia-mcp] No MCP-enabled routes found. Add `detail: { mcp: true }` to routes.");
				return;
			}

			console.log(`[elysia-mcp] Registered ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
			initialized = true;
		})
		.post(path, ({ request }) => handleMcpRequest(request))
		.get(path, ({ request }) => handleMcpRequest(request))
		.delete(path, ({ request }) => handleMcpRequest(request));
}
