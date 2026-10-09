const PATH_MENTION = /`((?:src|server|deploy|drizzle|scripts|e2e|tests|\.github)\/[^`\s]+)`/g;
const ROUTE_MENTION = /`(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`\s]+)`/g;

/** Headings (`## Title`) from `requiredHeadings` that the document does not contain as whole lines. */
export function missingHeadings(content, headings) {
	const lines = new Set(content.split("\n").map((line) => line.trimEnd()));
	return headings.filter((heading) => !lines.has(heading));
}

/** Backticked repository paths without globs or placeholders, with any `:line` suffix removed. */
export function mentionedRepositoryPaths(content) {
	const paths = new Set();
	for (const match of content.matchAll(PATH_MENTION)) {
		const raw = match[1];
		if (/[*<>{}]/.test(raw)) continue;
		paths.add(raw.replace(/:\d+(?:-\d+)?$/, ""));
	}
	return [...paths];
}

/** `METHOD /api/...` mentions in backticks; query strings are dropped. */
export function mentionedRoutes(content) {
	const routes = [];
	for (const match of content.matchAll(ROUTE_MENTION)) {
		routes.push({ method: match[1], route: match[2].split("?")[0].replace(/\/$/, "") });
	}
	return routes;
}

/** Whether a route like `/api/accounts/[id]` with the method exists in a `Map<route, string[]>` of explicit methods. */
export function routeExists(routes, method, route) {
	return routes.get(route)?.includes(method) ?? false;
}
