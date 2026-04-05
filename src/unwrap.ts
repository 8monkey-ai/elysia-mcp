/**
 * Response unwrapping utilities.
 *
 * Elysia handlers may return responses wrapped in `status(code, data)`.
 * This module extracts the raw response data for MCP JSON serialization.
 */

/**
 * Unwraps an Elysia response, extracting the raw data from
 * `ElysiaCustomStatusResponse` wrappers if present.
 */
export function unwrapResponse(response: unknown): unknown {
	if (response == null) return response;

	// ElysiaCustomStatusResponse has `.response` and `.code` properties
	if (
		typeof response === "object" &&
		"response" in (response as object) &&
		"code" in (response as object)
	) {
		return (response as { response: unknown }).response;
	}

	// Web Response object — try to detect and skip (we can't easily extract body synchronously)
	if (response instanceof Response) {
		return response;
	}

	return response;
}

/**
 * Converts an unwrapped response to MCP tool result format.
 */
export function toMcpContent(data: unknown): {
	content: Array<{ type: "text"; text: string }>;
} {
	if (data instanceof Response) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "Response object cannot be serialized directly",
					}),
				},
			],
		};
	}

	const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
	return { content: [{ type: "text", text }] };
}
