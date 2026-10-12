import { getEnv } from "@/lib/cloudflare";
import { MODULE_CAPABILITIES } from "./capability-registry";
import { bindHostRefResolver } from "./host";
import { invokeCapability } from "./invoke";
import type { CapabilityCallContext, JsonValue, ModuleId, RecordKind, RecordRef } from "./module-types";
import { createRefResolver } from "./record-ref-utils";
import type { RawRefResult, RefViewer, ResolvedRecordRef } from "./record-ref-types";
import { resolveCoreRefs } from "./record-refs-core";

type ResolveOptions = {
	timeZone?: string;
	locale?: string;
	requestId?: string;
	trigger?: CapabilityCallContext["trigger"];
	/** Grants the caller holds. Defaults to reading every module's records, as a signed-in session does. */
	grants?: string[];
};

/** The read grants a signed-in session holds for resolving refs. */
const SESSION_REF_GRANTS: string[] = [
	...new Set(
		MODULE_CAPABILITIES.flatMap((entry) =>
			entry.descriptors
				.filter((descriptor) => descriptor.surfaces.includes("resolve_refs"))
				.flatMap((d) => d.scopes ?? []),
		),
	),
];

function isRawResults(value: JsonValue): value is { results: RawRefResult[] } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray(value.results);
}

/**
 * Resolves record refs for a viewer: core kinds here, module kinds through the owning module's
 * `resolveRefs` capability, one call per module. Anything a viewer cannot see, a module that is off
 * and a failed call all come back as `{ unavailable: true, label }` with a neutral label.
 */
export async function resolveRecordRefs(
	env: Pick<CloudflareEnv, "DB">,
	viewer: RefViewer | null,
	refs: readonly { kind: string; id: string }[],
	options: ResolveOptions = {},
): Promise<ResolvedRecordRef[]> {
	const ctx: CapabilityCallContext = {
		viewer,
		requestId: options.requestId ?? "record-refs",
		locale: options.locale ?? "en",
		timeZone: options.timeZone ?? "UTC",
		grants: options.grants ?? SESSION_REF_GRANTS,
		trigger: options.trigger ?? "system",
	};
	const resolve = createRefResolver({
		resolveCore: (who, kind: RecordKind, ids) => resolveCoreRefs(env, who, kind, ids),
		invokeModule: async (moduleId: ModuleId, group: RecordRef[]) => {
			const result = await invokeCapability(moduleId, "resolveRefs", { refs: group }, ctx);
			return result.ok && isRawResults(result.output) ? result.output.results : null;
		},
	});
	return resolve(viewer, refs);
}

bindHostRefResolver(async (ctx, refs) => {
	const resolved = await resolveRecordRefs(getEnv(), ctx.viewer, refs, {
		timeZone: ctx.timeZone,
		locale: ctx.locale,
		requestId: ctx.requestId,
		trigger: ctx.trigger,
		grants: ctx.grants,
	});
	return resolved.map((ref) =>
		ref.unavailable
			? { kind: ref.kind, id: ref.id, unavailable: true, label: ref.label }
			: { kind: ref.kind, id: ref.id, href: ref.href, label: ref.label },
	);
});
