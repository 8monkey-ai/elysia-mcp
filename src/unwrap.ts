/**
 * Response unwrapping and formatting utilities.
 *
 * Extracts data from HTTP responses and converts it into MCP text content.
 */

import type { TextContent } from "@modelcontextprotocol/sdk/types.js";

type McpTextContent = { content: TextContent[] };

/**
 * Extract the response body from an HTTP Response and format it as MCP tool
 * content.  Parses JSON when the content-type indicates it; falls back to
 * plain text.  Always returns `{ content: [{ type: "text", text }] }`.
 */
export async function responseToMcpContent(response: Response): Promise<McpTextContent> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  let text: string;

  if (contentType.includes("application/json") && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      text = raw;
    }
  } else {
    text = raw;
  }

  return {
    content: [{ type: "text", text }],
  };
}
