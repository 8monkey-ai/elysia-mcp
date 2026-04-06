/**
 * Elysia MCP Plugin
 *
 * Auto-discovers routes and exposes them as MCP tools via a POST endpoint
 * handling the MCP JSON-RPC protocol. By default all routes are included;
 * opt out individual routes with `detail: { mcp: false }`, or set
 * `allRoutes: false` to require explicit `detail: { mcp: true }`.
 *
 * Uses `app.handle()` for tool invocation — every MCP tool call goes through
 * the full Elysia lifecycle (derive, resolve, beforeHandle, afterHandle, error
 * hooks, and all plugins).
 */

import type { Elysia } from "elysia";

// ─── Module Augmentation ────────────────────────────────────────────
// Extend Elysia's DocumentDecoration so `detail: { mcp: ... }` is type-safe.
declare module "elysia" {
  interface DocumentDecoration {
    mcp?: boolean | McpToolMeta;
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { deriveToolName } from "./naming.js";
import { asSchemaLike, flattenSchemas, unflattenArgs } from "./schema.js";
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
  /** Expose all routes as MCP tools by default (default: true).
   *  When true, every route becomes a tool unless it sets `mcp: false`.
   *  When false, only routes with `detail: { mcp: true }` are exposed. */
  allRoutes?: boolean;
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
  pathSegments: string[];
  hasBody: boolean;
  flatten: FlattenResult;
}

// ─── Route Discovery ─────────────────────────────────────────────────

function discoverTools(app: Elysia, allRoutes: boolean): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  const routes = app.routes;

  for (const route of routes) {
    // Elysia's route.hooks is typed as `any` — cast to Record
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const hooks = route.hooks as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const detail = hooks["detail"] as Record<string, unknown> | undefined;
    const mcpValue = detail?.["mcp"];

    // Skip routes that are explicitly opted out
    if (mcpValue === false) continue;

    // In opt-in mode, skip routes without `detail.mcp`
    if (!allRoutes && (mcpValue === undefined || mcpValue === null)) continue;

    const mcpMeta =
      typeof mcpValue === "object" && mcpValue !== null
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          (mcpValue as Record<string, unknown>)
        : undefined;
    const method = route.method.toUpperCase();
    const routePath = route.path;

    const mcpName = typeof mcpMeta?.["name"] === "string" ? mcpMeta["name"] : undefined;
    const mcpDescription =
      typeof mcpMeta?.["description"] === "string" ? mcpMeta["description"] : undefined;
    const name = mcpName ?? deriveToolName(method, routePath);
    const pathSegments = routePath.split("/");
    const hasBody = method !== "GET" && method !== "HEAD";

    const summary = detail?.["summary"];
    const description =
      mcpDescription ??
      (typeof summary === "string" ? summary : undefined) ??
      `${method} ${routePath}`;

    const flatten = flattenSchemas(name, {
      params: asSchemaLike(hooks["params"]),
      query: asSchemaLike(hooks["query"]),
      body: asSchemaLike(hooks["body"]),
    });

    for (const warning of flatten.warnings) {
      console.warn(warning);
    }

    tools.push({ name, description, method, pathSegments, hasBody, flatten });
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

  // Substitute path parameters (segment-safe to avoid prefix collisions
  // e.g. `:id` matching `:id2`)
  const resolvedPath = tool.pathSegments
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const key = segment.slice(1);
      if (!Object.prototype.hasOwnProperty.call(params, key)) return segment;
      return encodeURIComponent(String(params[key]));
    })
    .join("/");

  // Build query string
  const queryEntries = Object.entries(query).filter(([, v]) => v !== null && v !== undefined);
  const qs =
    queryEntries.length > 0
      ? `?${new URLSearchParams(queryEntries.map(([k, v]) => [k, String(v)])).toString()}`
      : "";

  const origin = new URL(originalRequest.url).origin;
  const url = `${origin}${resolvedPath}${qs}`;

  // Copy headers from the original MCP request (auth, cookies, etc.)
  const headers = new Headers(originalRequest.headers);

  const method = tool.method;
  const hasJsonBody = tool.hasBody && Object.keys(body).length > 0;

  // Sanitize content headers — the original values correspond to the
  // JSON-RPC payload, not the synthetic request's body.
  headers.delete("content-length");
  if (hasJsonBody) {
    headers.set("content-type", "application/json");
  } else {
    headers.delete("content-type");
  }
  const bodyContent = hasJsonBody ? JSON.stringify(body) : undefined;

  return new Request(url, {
    method,
    headers,
    body: bodyContent,
  });
}

async function parseResponseData(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (!contentType.includes("application/json") || text.length === 0) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Create MCP Server with tool handlers (one per request) ─────────

function createMcpServer(
  serverName: string,
  serverVersion: string,
  toolMap: Map<string, DiscoveredTool>,
  toolListResponse: {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: FlattenResult["schema"];
    }>;
  },
  rootApp: Elysia,
  originalRequest: Request,
): McpServer {
  const mcpServer = new McpServer(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } },
  );

  // Use the underlying Server for custom request handlers.
  // We bypass McpServer's registerTool() because our tools use pre-built
  // JSON Schema from flattenSchemas(), not Zod schemas.
  const server = mcpServer.server;

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

    const args = request.params.arguments ?? {};

    // Build a synthetic request and run through the full Elysia lifecycle
    const syntheticRequest = buildRequest(tool, args, originalRequest);
    const response = await rootApp.handle(syntheticRequest);
    const data = await parseResponseData(response);
    const result = toMcpContent(data);

    if (!response.ok) {
      return {
        isError: true,
        content: result.content,
      };
    }

    return result;
  });

  return mcpServer;
}

// ─── Plugin ──────────────────────────────────────────────────────────

/**
 * Create the Elysia MCP plugin.
 *
 * By default all routes are exposed as MCP tools. Set `allRoutes: false`
 * to require explicit opt-in via `detail: { mcp: true }`, or opt out
 * individual routes with `detail: { mcp: false }`.
 *
 * **Important:** `.use(mcp())` must come after all MCP-eligible routes are
 * registered, as route discovery happens at plugin mount time.
 */
export function mcp(options: McpPluginOptions = {}) {
  const { name = "elysia-mcp", version = "1.0.0", path = "/mcp", allRoutes = true } = options;

  // Return a function-style plugin to capture the parent Elysia app reference.
  // This gives us access to app.routes (for discovery) and app.handle() (for
  // tool invocation through the full lifecycle).
  return (app: Elysia) => {
    const tools = discoverTools(app, allRoutes);

    // Build a Map for O(1) tool lookup by name
    const toolMap = new Map<string, DiscoveredTool>();
    for (const tool of tools) {
      if (toolMap.has(tool.name)) {
        console.warn(`[mcp] Duplicate tool name "${tool.name}" — later route will override`);
      }
      toolMap.set(tool.name, tool);
    }
    const toolListResponse = {
      tools: Array.from(toolMap.values(), (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.flatten.schema,
      })),
    };

    if (tools.length === 0) {
      console.warn("[mcp] No MCP-eligible routes found — MCP server will have no tools");
    } else {
      console.info(
        `[mcp] Discovered ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`,
      );
    }

    return app.post(path, async ({ request, body }: { request: Request; body: unknown }) => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      // Create a fresh McpServer per request — the MCP SDK's
      // Protocol.connect() throws if the server is already connected,
      // so reusing a single instance across concurrent requests would fail.
      const server = createMcpServer(name, version, toolMap, toolListResponse, app, request);
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, {
          parsedBody: body,
        });
      } finally {
        await transport.close();
      }
    });
  };
}
