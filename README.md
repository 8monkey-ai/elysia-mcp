# @8monkey/elysia-mcp

Turn your existing Elysia routes into MCP tools — no manual registration, no schema duplication, no handler rewrites.

## Why?

The [Model Context Protocol](https://modelcontextprotocol.io/) lets AI agents discover and call tools over a standard JSON-RPC interface. If you already have an Elysia API with typed schemas and handlers, you shouldn't have to rewrite all of that as MCP tool definitions.

`@8monkey/elysia-mcp` bridges the gap: add `.use(mcp())` and every endpoint becomes a callable MCP tool — with its name, description, and input schema derived from what you already wrote.

## Key highlights

- **Zero duplication** — tool names, descriptions, and input schemas are derived from your existing route definitions
- **Full lifecycle** — MCP tool calls go through `app.handle()`, so derive, resolve, beforeHandle, afterHandle, error hooks, and all plugins run exactly as they do for normal HTTP requests
- **Header forwarding** — auth tokens, cookies, and other headers from the MCP request are forwarded to tool invocations, so your existing auth middleware works without changes
- **Schema flattening** — params, query, and body schemas are merged into a single flat MCP input schema with property origins tracked for correct unflattening
- **Startup diagnostics** — warns on name collisions across params/query/body, missing property descriptions, and duplicate tool names
- **Response unwrapping** — automatically unwraps Elysia `status()` responses so MCP clients receive clean data
- **Smart naming** — `GET /users` becomes `list_users`, `GET /users/:id` becomes `get_user`, `POST /users` becomes `create_user`, and nested paths like `GET /users/:uid/posts` become `list_user_posts`

## How it differs from existing solutions

Compared to [kerlos/elysia-mcp](https://github.com/kerlos/elysia-mcp) and [keithagroves/Elysia-mcp](https://github.com/keithagroves/Elysia-mcp), which require manual tool registration with separate Zod schemas and standalone handlers:

- **Auto-discovery** — routes become tools automatically; no registration callbacks
- **Schema reuse** — uses your existing TypeBox/Standard Schema definitions instead of duplicating with Zod
- **Full lifecycle execution** — tool calls run through `app.handle()`, not standalone functions, so all middleware applies
- **Streamable HTTP** — stateless POST endpoint instead of stateful sessions or SSE connections

## Install

```bash
bun add @8monkey/elysia-mcp
```

Peer dependency: `elysia >= 1.0.0`

## Basic usage

Add `.use(mcp())` after your routes — that's it. All routes become MCP tools:

```typescript
import { Elysia } from "elysia";
import { mcp } from "@8monkey/elysia-mcp";

const app = new Elysia()
  .get("/users", () => db.users.findAll())
  .get("/users/:id", ({ params }) => db.users.find(params.id))
  .post("/users", ({ body }) => db.users.create(body))
  .use(mcp())
  .listen(3000);
```

This exposes a `POST /mcp` endpoint. An MCP client calling `tools/list` will see `list_users`, `get_user`, and `create_user`.

## Adding descriptions

Use `detail.summary` to give tools human-readable descriptions:

```typescript
.get("/users", () => db.users.findAll(), {
  detail: { summary: "List all users" },
})
```

## Adding input schemas

TypeBox schemas on params, query, and body are automatically flattened into the tool's input schema:

```typescript
import { t } from "elysia";

.get("/users/:id", ({ params }) => db.users.find(params.id), {
  params: t.Object({
    id: t.String({ description: "The user's unique ID" }),
  }),
  detail: { summary: "Get user by ID" },
})
```

MCP tools accept a single flat input object. The plugin merges `params`, `query`, and `body` into one schema:

```text
Route: PATCH /users/:id  (params: { id }, query: { fields }, body: { name, email })
  ↓
MCP Tool Input: { id: string, fields?: string, name: string, email: string }
```

Property descriptions are preserved. The plugin warns at startup if properties collide across buckets or lack descriptions.

## Opting routes out

By default, all routes are exposed. Opt out individual routes with `mcp: false`:

```typescript
.get("/health", () => ({ status: "ok" }), {
  detail: { mcp: false },
})
```

Or flip the default — set `allRoutes: false` to require explicit opt-in:

```typescript
.get("/users", () => db.users.findAll(), {
  detail: { mcp: true },  // only this route becomes a tool
})
.get("/health", () => "ok")  // not exposed
.use(mcp({ allRoutes: false }))
```

## Overriding tool names and descriptions

Auto-generated names follow a `{verb}_{resource}` convention. Override with `mcp: { name, description }`:

```typescript
.get("/items", handler, {
  detail: {
    mcp: { name: "search_items", description: "Full-text search across all items" },
  },
})
```

### Naming conventions

| Method + Path | Generated Name |
|---|---|
| `GET /users` | `list_users` |
| `GET /users/:id` | `get_user` |
| `POST /users` | `create_user` |
| `PATCH /users/:id` | `update_user` |
| `DELETE /users/:id` | `delete_user` |
| `GET /users/:uid/posts` | `list_user_posts` |

## Configuration

```typescript
mcp({
  name: "my-api",       // MCP server name (default: "elysia-mcp")
  version: "1.0.0",     // MCP server version (default: "1.0.0")
  path: "/mcp",         // Endpoint path (default: "/mcp")
  allRoutes: true,      // Expose all routes by default (default: true)
})
```

## How tool calls work

When an MCP client calls a tool:

1. The flat args are unflattened back into `params`, `query`, and `body`
2. A synthetic HTTP request is built with the correct method, path, query string, body, and headers from the original MCP request
3. `app.handle(request)` runs the full Elysia lifecycle — derive, resolve, beforeHandle, the handler, afterHandle, and error hooks
4. The response is unwrapped (handles `status()` wrappers) and returned as MCP content

This means your auth middleware, rate limiting, validation, and every other plugin work exactly the same for MCP calls as they do for REST calls.

## Connecting an MCP client

Point any MCP-compatible client at your `/mcp` endpoint. For example, with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector --transport http http://localhost:3000/mcp
```

Or configure it in Claude Desktop, Cursor, or any other MCP-enabled tool as an HTTP MCP server at `http://localhost:3000/mcp`.

## Important notes

- **Plugin order matters**: `.use(mcp())` must come after all MCP-eligible routes, since route discovery happens at mount time. This is the same pattern as other Elysia plugins (e.g., `derive` must precede routes that use it).
- **Tools only (v1)**: This plugin exposes MCP tools. Resources and prompts are not supported yet.
- **Stateless transport**: Each request gets its own transport instance — no session tracking or SSE connections to manage.

## License

MIT
