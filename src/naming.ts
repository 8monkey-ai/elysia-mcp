/**
 * Auto-generates MCP tool names from HTTP method + path.
 *
 * Conventions:
 *   GET /collection       → list_collection
 *   GET /collection/:id   → get_singular
 *   POST /collection      → create_singular
 *   PATCH /collection/:id → update_singular
 *   PUT /collection/:id   → update_singular
 *   DELETE /collection/:id → delete_singular
 */

/**
 * Naive singularisation — covers the most common REST resource names.
 * Not meant to be a full NLP stemmer.
 */
export function singularize(word: string): string {
	const lower = word.toLowerCase();

	// Order matters — most specific rules first
	if (lower.endsWith("ies") && lower.length > 3) {
		return `${lower.slice(0, -3)}y`;
	}
	if (lower.endsWith("ses") || lower.endsWith("xes") || lower.endsWith("zes")) {
		return lower.slice(0, -2);
	}
	if (lower.endsWith("ches") || lower.endsWith("shes")) {
		return lower.slice(0, -2);
	}
	if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 1) {
		return lower.slice(0, -1);
	}
	return lower;
}

/** True when the segment is a path parameter like `:id` */
function isParam(segment: string): boolean {
	return segment.startsWith(":");
}

/**
 * Derive an MCP tool name from an HTTP method and route path.
 *
 * Examples:
 *   ("GET",    "/users")            → "list_users"
 *   ("GET",    "/users/:id")        → "get_user"
 *   ("POST",   "/users")            → "create_user"
 *   ("PATCH",  "/users/:id")        → "update_user"
 *   ("DELETE", "/users/:id")        → "delete_user"
 *   ("GET",    "/users/:uid/posts") → "list_user_posts"
 */
export function deriveToolName(method: string, path: string): string {
	const segments = path
		.split("/")
		.filter((s) => s.length > 0);

	// Collect non-parameter segments
	const parts = segments.filter((s) => !isParam(s));
	const endsWithParam = segments.length > 0 && isParam(segments[segments.length - 1]!);
	const upperMethod = method.toUpperCase();

	let prefix: string;
	if (upperMethod === "GET" && !endsWithParam) {
		prefix = "list";
	} else if (upperMethod === "GET") {
		prefix = "get";
	} else if (upperMethod === "POST") {
		prefix = "create";
	} else if (upperMethod === "PATCH" || upperMethod === "PUT") {
		prefix = "update";
	} else if (upperMethod === "DELETE") {
		prefix = "delete";
	} else {
		prefix = upperMethod.toLowerCase();
	}

	// Methods that operate on a single resource — the last segment should be singular
	const singleResource =
		upperMethod === "POST" ||
		upperMethod === "PATCH" ||
		upperMethod === "PUT" ||
		upperMethod === "DELETE" ||
		endsWithParam;

	// Track original segment indices for non-param parts so we can check
	// what follows each one (handles duplicate segment names correctly).
	const partIndices: number[] = [];
	for (let idx = 0; idx < segments.length; idx++) {
		if (!isParam(segments[idx]!)) partIndices.push(idx);
	}

	// Singularise segments that are followed by a param, or (for single-resource
	// methods) the last non-param segment
	const named = parts.map((part, i) => {
		const nextSegment = segments[partIndices[i]! + 1];
		const followedByParam = nextSegment != null && isParam(nextSegment);

		if (followedByParam || (singleResource && i === parts.length - 1)) {
			return singularize(part);
		}
		return part;
	});

	return [prefix, ...named].join("_");
}
