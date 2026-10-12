import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "./module-types";

/** A handler a later change fills in; calling it is a handler error, never a silent success. */
export function pendingHandler(label: string): CapabilityHandler {
	return async () => {
		throw new Error(`${label} is not implemented yet`);
	};
}

export type RefsInput = { refs: { kind: string; id: string }[] };
export type FoundRef = { href: string | null; label: string };

/** The refs a `resolveRefs` call asks about; the invoker has already validated the shape. */
export function refsOf(input: JsonValue): RefsInput["refs"] {
	return (input as RefsInput).refs;
}

export const refKey = (kind: string, id: string) => `${kind}:${id}`;

/**
 * A `resolveRefs` answer: one entry per asked ref, in order. A ref the handler did not find is
 * unavailable and carries no label, so core fills in the neutral one.
 */
export function refsOutput(refs: RefsInput["refs"], found: Map<string, FoundRef>): JsonValue {
	return {
		results: refs.map(({ kind, id }): JsonValue => {
			const hit = found.get(refKey(kind, id));
			return hit ? { kind, id, href: hit.href, label: hit.label } : { kind, id, unavailable: true };
		}),
	};
}

/** Ids per query: D1 allows 100 bound parameters, and every query also binds the viewer. */
const IDS_PER_QUERY = 50;

export async function forEachIdChunk(ids: string[], run: (chunk: string[]) => Promise<void>): Promise<void> {
	for (let start = 0; start < ids.length; start += IDS_PER_QUERY) await run(ids.slice(start, start + IDS_PER_QUERY));
}

export function idsOfKind(refs: RefsInput["refs"], kind: string): string[] {
	return [...new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id))];
}

export function viewerId(ctx: CapabilityCallContext): string | null {
	return ctx.viewer?.userId ?? null;
}
