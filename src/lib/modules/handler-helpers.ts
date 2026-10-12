import type { CapabilityHandler, JsonValue } from "./module-types";

/** A handler a later change fills in; calling it is a handler error, never a silent success. */
export function pendingHandler(label: string): CapabilityHandler {
	return async () => {
		throw new Error(`${label} is not implemented yet`);
	};
}

/** Answers every ref as unavailable until the module resolves its own records. */
export const unavailableRefsHandler: CapabilityHandler = async (input: JsonValue) => {
	const refs = (input as { refs: { kind: string; id: string }[] }).refs;
	return { results: refs.map((ref) => ({ kind: ref.kind, id: ref.id, unavailable: true })) };
};
