/**
 * Response unwrapping and formatting utilities.
 *
 * Extracts data from HTTP responses and converts it into MCP text content.
 */

import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

type McpTextContent = { content: TextContent[] };

function toTextContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Extract the response body from an HTTP Response.
 * Parses JSON when the content-type indicates it; falls back to plain text.
 */
export async function parseResponseData(response: Response): Promise<unknown> {
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
