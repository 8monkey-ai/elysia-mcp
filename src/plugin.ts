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

import type { DocumentDecoration, Elysia } from "elysia";

// ─── Module Augmentation ────────────────────────────────────────────
// Extend Elysia's DocumentDecoration so `detail: { mcp: ... }` is type-safe.
declare module "elysia" {
  interface DocumentDecoration {
    mcp?: boolean;
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { deriveToolName } from "./naming.js";
import { asSchemaLike, cleanResponseSchema, flattenSchemas, unflattenArgs } from "./schema.js";
import type { FlatJsonSchema, FlattenResult } from "./schema.js";
import { responseToMcpContent } from "./unwrap.js";

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

interface DiscoveredTool {
  name: string;
  description: string;
  method: string;
  pathSegments: string[];
  flatten: FlattenResult;
  outputSchema?: FlatJsonSchema;
}

type RouteHooks = {
  detail?: DocumentDecoration;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response?: unknown;
};

function discoverTools(
  app: Elysia,
  allRoutes: boolean,
  warn: (msg: string) => void,
): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];

  for (const route of app.routes) {
    // Elysia route introspection loses the concrete hook type, but these are
    // the fields stored on route hooks that this plugin reads.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const hooks = route.hooks as RouteHooks;
    const detail = hooks.detail;
    const mcpEnabled = detail?.mcp;

    // Skip routes that are explicitly opted out
    if (mcpEnabled === false) continue;

    // In opt-in mode, skip routes without `detail.mcp`
    if (!allRoutes && (mcpEnabled === undefined || mcpEnabled === null)) continue;

    const method = route.method.toUpperCase();

    // OPTIONS and HEAD have no semantic value as MCP tools
    if (method === "OPTIONS" || method === "HEAD") continue;

    const routePath = route.path;
    const name = detail?.operationId ?? deriveToolName(method, routePath);
    const pathSegments = routePath.split("/");
    const description = detail?.summary ?? `${method} ${routePath}`;

    let flatten: FlattenResult;
    let outputSchema: FlatJsonSchema | undefined;

    try {
      const bodySchema = method === "GET" ? undefined : asSchemaLike(hooks.body);

      // Non-object body schemas (arrays, primitives) cannot be flattened into MCP
      // tool arguments — unflattenArgs() would return body: undefined, silently
      // dropping the body from the synthetic request. Skip and warn instead.
      if (bodySchema !== undefined && bodySchema !== null && bodySchema["type"] !== "object") {
        warn(
          `[mcp] Tool "${name}": body schema type "${String(bodySchema["type"])}" cannot be represented as MCP tool arguments — route skipped`,
        );
        continue;
      }

      flatten = flattenSchemas(name, {
        params: asSchemaLike(hooks.params),
        query: asSchemaLike(hooks.query),
        body: bodySchema,
      });

      outputSchema = cleanResponseSchema(asSchemaLike(hooks.response));
    } catch (err) {
      warn(`[mcp] Route "${method} ${routePath}" skipped — schema conversion failed: ${String(err)}`);
      continue;
    }

    for (const warning of flatten.warnings) {
      warn(warning);
    }

    if (hooks.response !== undefined && hooks.response !== null && outputSchema === undefined) {
      warn(
        `[mcp] Tool "${name}": response schema is not type: "object" — outputSchema omitted (structuredContent unavailable)`,
      );
    }

    tools.push({ name, description, method, pathSegments, flatten, outputSchema });
  }

  return tools;
}

// ─── Build synthetic Request for app.handle() ────────────────────────

function buildRequest(
  tool: DiscoveredTool,
  args: Record<string, unknown>,
  originalRequest: Request,
): Request {
  const { params, query, body } = unflattenArgs(args, tool.flatten);

  // Substitute path parameters (segment-safe to avoid prefix collisions
  // e.g. `:id` matching `:id2`)
  const resolvedPath = tool.pathSegments
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const key = segment.slice(1);
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required path parameter "${key}" for tool ${tool.name}`,
        );
      }
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

  // Sanitize content headers — the original values correspond to the
  // JSON-RPC payload, not the synthetic request's body.
  headers.delete("content-length");
  if (body === undefined) {
    headers.delete("content-type");
  } else {
    headers.set("content-type", "application/json");
  }
  const bodyContent = body === undefined ? undefined : JSON.stringify(body);

  return new Request(url, {
    method: tool.method,
    headers,
    body: bodyContent,
  });
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
      throw new McpError(ErrorCode.InvalidParams, `Tool ${toolName} not found`);
    }

    const args = request.params.arguments ?? {};

    // Build a synthetic request and run through the full Elysia lifecycle
    const syntheticRequest = buildRequest(tool, args, originalRequest);
    const response = await rootApp.handle(syntheticRequest);
    const result = await responseToMcpContent(response, tool.outputSchema !== undefined);

    if (!response.ok) {
      return {
        isError: true,
        content: result.content,
      };
    }

    // When the tool declares an outputSchema and the response is a JSON object,
    // include structuredContent so MCP clients can consume typed data.
    if (
      tool.outputSchema !== undefined &&
      result.parsed !== null &&
      result.parsed !== undefined &&
      typeof result.parsed === "object" &&
      !Array.isArray(result.parsed)
    ) {
      return {
        content: result.content,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        structuredContent: result.parsed as Record<string, unknown>,
      };
    }

    return { content: result.content };
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
 */
export function mcp(options: McpPluginOptions = {}) {
  const { name = "elysia-mcp", version = "1.0.0", path = "/mcp", allRoutes = true } = options;

  // Return a function-style plugin to capture the parent Elysia app reference.
  // This gives us access to app.routes (for discovery) and app.handle() (for
  // tool invocation through the full lifecycle).
  return (app: Elysia) => {
    // Cache invalidated whenever the route count changes (same strategy as elysia-openapi).
    const emitted = new Set<string>();
    const warn = (msg: string): void => {
      if (emitted.has(msg)) return;
      emitted.add(msg);
      console.warn(msg);
    };
    let cachedRouteCount = -1;

    let toolMap = new Map<string, DiscoveredTool>();
    let toolListResponse: {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: FlattenResult["schema"];
      }>;
    } = { tools: [] };

    function refreshTools() {
      if (app.routes.length === cachedRouteCount) return;
      cachedRouteCount = app.routes.length;

      const tools = discoverTools(app, allRoutes, warn);

      toolMap = new Map<string, DiscoveredTool>();
      for (const tool of tools) {
        if (toolMap.has(tool.name)) {
          warn(`[mcp] Duplicate tool name "${tool.name}" — later route will override`);
        }
        toolMap.set(tool.name, tool);
      }
      toolListResponse = {
        tools: Array.from(toolMap.values(), (tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.flatten.schema,
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        })),
      };

      if (tools.length === 0) {
        warn("[mcp] No MCP-eligible routes found — MCP server will have no tools");
      }
    }

    return app.post(
      path,
      async ({ request, body }: { request: Request; body: unknown }) => {
        refreshTools();

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
      },
      { detail: { mcp: false } },
    );
  };
}
