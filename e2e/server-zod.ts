import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { z } from "zod";

import { mcp } from "../src/index.js";

const landingPage = `elysia-mcp e2e sample (Zod)

Available endpoints
===================

GET  /
POST /letters/count
POST /mcp

Example
=======

curl -X POST "http://localhost:3000/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 1
  }'
`;

function countLetters(word: string, letters: string) {
  const counts = new Map<string, number>();
  let total = 0;
  const lettersSet = new Set(letters.toLowerCase());

  for (const char of word.toLowerCase()) {
    if (!lettersSet.has(char)) continue;
    counts.set(char, (counts.get(char) ?? 0) + 1);
    total += 1;
  }

  const matches = Array.from(counts.entries(), ([letter, count]) => ({ letter, count }));

  return {
    word,
    letters,
    total,
    matches,
  };
}

export function createZodE2eSampleApp() {
  return new Elysia()
    .use(
      cors({
        origin: true,
        methods: "*",
        allowedHeaders: "*",
      }),
    )
    .get("/", () => landingPage)
    .post(
      "/letters/count",
      ({ body }) => countLetters(body.word, body.letters),
      {
        body: z.object({
          word: z.string().describe("The word to analyze"),
          letters: z
            .string()
            .describe("The letters to count (for example 'aeiou' for vowels)"),
        }),
        response: z.object({
          word: z.string().describe("The original input word"),
          letters: z.string().describe("The letters that were counted"),
          total: z.number().describe("The total number of matching letters"),
          matches: z
            .array(
              z.object({
                letter: z.string().describe("The matched letter"),
                count: z.number().describe("How many times that letter appeared"),
              }),
            )
            .describe("Per-letter match counts"),
        }),
        detail: {
          operationId: "count_letters",
          summary: "Counts occurrences of specific letters in a given word",
          mcp: true,
        },
      },
    )
    // The plugin discovers the route above and exposes it as an MCP tool.
    .use(
      mcp({
        name: "elysia-mcp-e2e-zod",
        version: "0.0.0",
        allRoutes: false,
      }),
    );
}

if (import.meta.main) {
  const app = createZodE2eSampleApp().listen(3000);

  console.info(`[e2e:zod] sample server listening on http://localhost:${app.server?.port}`);
  console.info(`[e2e:zod] REST route: http://localhost:${app.server?.port}/letters/count`);
  console.info(`[e2e:zod] MCP endpoint: http://localhost:${app.server?.port}/mcp`);
}
