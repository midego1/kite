import templates from "./metrics-routes.generated.json";

type Compiled = { template: string; segments: string[]; specificity: number };

function compile(template: string): Compiled {
	const segments = template.split("/").filter(Boolean);
	// Literal segments beat `[x]`, which beats catch-alls, so `/api/a/me` wins over `/api/a/[id]`.
	const specificity = segments.reduce(
		(score, segment) =>
			score * 3 + (segment.startsWith("[[...") || segment.startsWith("[...") ? 0 : /^\[.+\]$/.test(segment) ? 1 : 2),
		0,
	);
	return { template, segments, specificity };
}

const COMPILED = (templates as string[]).map(compile).sort((a, b) => b.specificity - a.specificity);

function matches(route: Compiled, parts: string[]): boolean {
	for (let index = 0; index < route.segments.length; index++) {
		const segment = route.segments[index];
		if (segment.startsWith("[[...") || segment.startsWith("[..."))
			return segment.startsWith("[[...") || parts.length > index;
		if (index >= parts.length) return false;
		if (!/^\[.+\]$/.test(segment) && segment !== parts[index]) return false;
	}
	return route.segments.length === parts.length;
}

/** Maps a concrete pathname to its route template; raw segments are never returned. */
export function routeTemplate(pathname: string): string {
	const parts = pathname.split("/").filter(Boolean);
	return COMPILED.find((route) => matches(route, parts))?.template ?? "unmatched";
}
