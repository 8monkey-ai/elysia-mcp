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
 * content.  When {@link needsParsed} is true the JSON body is also parsed so
 * callers can populate `structuredContent` for tools with `outputSchema`.
 *
 * Performance: skips `JSON.parse` entirely when `needsParsed` is false —
 * the raw response text is used directly as the MCP text content, avoiding
 * a parse → re-stringify round-trip.
 */
export async function responseToMcpContent(
  response: Response,
  needsParsed = false,
): Promise<McpContentResult> {
  const raw = await response.text();

  if (!needsParsed || raw.length === 0) {
    return { content: [{ type: "text", text: raw }] };
  }

  // Only parse when the caller needs the structured object.
  // Use `raw` as-is for text content — it's already the serialized form.
  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      content: [{ type: "text", text: raw }],
      parsed,
    };
  } catch {
    return { content: [{ type: "text", text: raw }] };
  }
}
