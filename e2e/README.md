# E2E Sample

These samples are intentionally route-first: define a normal Elysia handler at `POST /letters/count`, then mount `@8monkey/elysia-mcp` with `.use(mcp())` so that route is exposed as the `count_letters` MCP tool.

## Included samples

- `server-typebox.ts` uses TypeBox schemas and `description`
- `server-zod.ts` uses Zod 4 schemas and `.describe()`

## Run the TypeBox sample server

```bash
bun e2e/server-typebox.ts
```

## Run the Zod sample server

```bash
bun e2e/server-zod.ts
```

The REST route is available at `http://localhost:3000/letters/count`.

The MCP plugin endpoint is available at `http://localhost:3000/mcp`.

Both variants expose the same `count_letters` MCP tool at `POST /mcp`.

These samples are HTTP MCP servers.


## Test with MCP Inspector

If you use MCP Inspector, connect with HTTP transport to the running endpoint:

```bash
bunx @modelcontextprotocol/inspector --transport http http://localhost:3000/mcp
```
