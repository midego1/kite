import type { CapabilityCallContext, ModuleId, RecordKind, RecordRef } from "./module-types";

/** The answer for one ref: a label and an optional same-origin link, or a neutral label with no link. */
export type ResolvedRecordRef =
	| { kind: string; id: string; href: string | null; label: string; unavailable?: undefined }
	| { kind: string; id: string; unavailable: true; label: string };

/** What a resolver (core or module) may return for one ref before core checks it. */
export type RawRefResult = { kind: string; id: string; href?: string | null; label?: string; unavailable?: boolean };

/** What the UI needs to draw a ref: text, plus a link only when `href` is set. */
export type RecordRefTarget = { href: string | null; label: string };

export type RefViewer = NonNullable<CapabilityCallContext["viewer"]>;

export type RefResolverDeps = {
	/** Resolves refs of one core kind. A throw makes every ref of that kind unavailable. */
	resolveCore(viewer: RefViewer, kind: RecordKind, ids: string[]): Promise<RawRefResult[]>;
	/** Calls the owner's `resolveRefs` capability; `null` means the call failed or the module is off. */
	invokeModule(moduleId: ModuleId, refs: RecordRef[]): Promise<RawRefResult[] | null>;
};
