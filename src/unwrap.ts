/**
 * Response formatting utilities.
 *
 * Converts handler responses into MCP text content payloads.
 */

import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

type McpTextContent = { content: TextContent[] };

function toTextContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Format a handler result as MCP tool content.
 * Always returns `{ content: [{ type: "text", text: string }] }`.
 */
export function toMcpContent(data: unknown): McpTextContent {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }

  return {
    content: [toTextContent(text)],
  };
}
