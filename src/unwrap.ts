/**
 * Response unwrapping and formatting utilities.
 *
 * Extracts data from HTTP responses and converts it into MCP text content.
 */

import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

export type McpContentResult = {
  content: TextContent[];
  /** The parsed JSON data, available when the response was valid JSON. */
  parsed?: unknown;
};

/**
 * Extract the response body from an HTTP Response and format it as MCP tool
 * content.  Parses JSON when the content-type indicates it; falls back to
 * plain text.  Returns both text content and the parsed data (when available)
 * so callers can use `structuredContent` for tools with `outputSchema`.
 */
export async function responseToMcpContent(response: Response): Promise<McpContentResult> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  let text: string;
  let parsed: unknown;

  if (contentType.includes("application/json") && raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
      text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      text = raw;
    }
  } else {
    text = raw;
  }

  return {
    content: [{ type: "text", text }],
    parsed,
  };
}
