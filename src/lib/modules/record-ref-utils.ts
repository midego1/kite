import type { ModuleId, RecordKind, RecordRef } from "./module-types";
import type { RawRefResult, RecordRefTarget, RefResolverDeps, RefViewer, ResolvedRecordRef } from "./record-ref-types";
import { isSameOriginPath } from "./path-utils";
import { MODULE_MANIFESTS } from "./registry";

/** Core-owned kinds with the neutral label shown when the record cannot be shown. */
const CORE_KIND_LABELS: Record<string, string> = {
	"mail:message": "Message",
	"mail:thread": "Conversation",
	"mail:mailbox": "Mailbox",
	"user:user": "User",
	"contact:contact": "Contact",
};

/** Kinds core reserves but cannot resolve until the page they would open exists. */
const RESERVED_KINDS: readonly string[] = ["contact:contact"];

const UNKNOWN_KIND_LABEL = "Record";
const KIND_FORM = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)$/;
const REF_FORM = /^([a-z][a-z0-9_]*:[a-z][a-z0-9_]*):(.+)$/;
/** `resolveRefs` takes at most this many refs per call. */
const REFS_PER_CALL = 100;
const MAX_LABEL_LENGTH = 200;

const moduleKinds = new Map<string, { moduleId: ModuleId; unavailableLabel: string }>(
	MODULE_MANIFESTS.flatMap((manifest) =>
		manifest.recordKinds.map(
			(entry) => [entry.kind, { moduleId: manifest.id, unavailableLabel: entry.unavailableLabel }] as const,
		),
	),
);

function isRecordKind(value: unknown): value is RecordKind {
	return typeof value === "string" && (value in CORE_KIND_LABELS || moduleKinds.has(value));
}

/**
 * Splits a known `<namespace>:<type>` kind; anything else, including an unknown kind, is `null`.
 * @public Reserved by spec §12 for refs in payloads and audit metadata; tests only today.
 */
export function parseRecordKind(value: unknown): { namespace: string; type: string } | null {
	if (!isRecordKind(value)) return null;
	const match = KIND_FORM.exec(value);
	return match ? { namespace: match[1], type: match[2] } : null;
}

/**
 * Parses `<namespace>:<type>:<id>`; the id may itself contain colons.
 * @public Reserved by spec §12 for refs in payloads and audit metadata; tests only today.
 */
export function parseRecordRef(value: unknown): RecordRef | null {
	if (typeof value !== "string") return null;
	const match = REF_FORM.exec(value);
	if (!match || !isRecordKind(match[1])) return null;
	return { kind: match[1], id: match[2] };
}

/** @public Reserved by spec §12 for refs in payloads and audit metadata; tests only today. */
export function formatRecordRef(ref: RecordRef): string {
	return `${ref.kind}:${ref.id}`;
}

/** The label that names a kind without naming a record, from the manifest for module kinds. */
export function neutralRefLabel(kind: string): string {
	return CORE_KIND_LABELS[kind] ?? moduleKinds.get(kind)?.unavailableLabel ?? UNKNOWN_KIND_LABEL;
}

function unavailable(kind: string, id: string): ResolvedRecordRef {
	return { kind, id, unavailable: true, label: neutralRefLabel(kind) };
}

/** Checks one resolver answer; a resolver bug can only produce an unavailable ref, never an unsafe link. */
function settle(ref: RecordRef, raw: RawRefResult | undefined): ResolvedRecordRef {
	if (!raw || raw.unavailable) return unavailable(ref.kind, ref.id);
	const label = typeof raw.label === "string" ? raw.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
	const href = raw.href ?? null;
	if (!label || (href !== null && !isSameOriginPath(href))) return unavailable(ref.kind, ref.id);
	return { kind: ref.kind, id: ref.id, href, label };
}

/** What the UI draws for a resolved ref: a link only when the ref is available and its href is same-origin. */
export function refTarget(resolved: ResolvedRecordRef): RecordRefTarget {
	if (resolved.unavailable) return { href: null, label: resolved.label };
	return { href: isSameOriginPath(resolved.href) ? resolved.href : null, label: resolved.label };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
	const groups = new Map<K, T[]>();
	for (const item of items) {
		const group = groups.get(key(item));
		if (group) group.push(item);
		else groups.set(key(item), [item]);
	}
	return groups;
}

/**
 * Resolves refs in input order. Core kinds are resolved once per kind and module kinds once per owning
 * module (split only past the call limit); a failed, disabled or lying resolver turns its refs into
 * unavailable ones with the neutral label.
 */
export function createRefResolver(deps: RefResolverDeps) {
	async function resolveCoreKind(viewer: RefViewer, kind: RecordKind, refs: RecordRef[]) {
		const raw = await deps.resolveCore(
			viewer,
			kind,
			refs.map((ref) => ref.id),
		);
		return refs.map((ref) =>
			settle(
				ref,
				raw.find((item) => item.kind === kind && item.id === ref.id),
			),
		);
	}

	async function resolveModule(viewer: RefViewer, moduleId: ModuleId, refs: RecordRef[]) {
		void viewer;
		const calls: RecordRef[][] = [];
		for (let start = 0; start < refs.length; start += REFS_PER_CALL)
			calls.push(refs.slice(start, start + REFS_PER_CALL));
		const answers = await Promise.all(calls.map((chunk) => deps.invokeModule(moduleId, chunk)));
		return calls.flatMap((chunk, index) => {
			const raw = answers[index];
			return chunk.map((ref) =>
				raw
					? settle(
							ref,
							raw.find((item) => item.kind === ref.kind && item.id === ref.id),
						)
					: unavailable(ref.kind, ref.id),
			);
		});
	}

	return async function resolve(
		viewer: RefViewer | null,
		refs: readonly { kind: string; id: string }[],
	): Promise<ResolvedRecordRef[]> {
		const unique = [...new Map(refs.map((ref) => [formatRecordRef(ref as RecordRef), ref as RecordRef])).values()];
		const answers = new Map<string, ResolvedRecordRef>();
		const pending: Promise<void>[] = [];
		const record = (resolved: ResolvedRecordRef[]) => {
			for (const item of resolved) answers.set(formatRecordRef(item as RecordRef), item);
		};
		const guarded = (refsOf: RecordRef[], run: () => Promise<ResolvedRecordRef[]>) =>
			pending.push(run().then(record, () => record(refsOf.map((ref) => unavailable(ref.kind, ref.id)))));

		const resolvable: RecordRef[] = [];
		for (const ref of unique) {
			const owned = isRecordKind(ref.kind) && !RESERVED_KINDS.includes(ref.kind) && !!viewer;
			if (owned) resolvable.push(ref);
			else answers.set(formatRecordRef(ref), unavailable(ref.kind, ref.id));
		}
		if (viewer) {
			const byKind = groupBy(
				resolvable.filter((ref) => !moduleKinds.has(ref.kind)),
				(ref) => ref.kind,
			);
			for (const [kind, group] of byKind) guarded(group, () => resolveCoreKind(viewer, kind as RecordKind, group));
			const byModule = groupBy(
				resolvable.filter((ref) => moduleKinds.has(ref.kind)),
				(ref) => moduleKinds.get(ref.kind)!.moduleId,
			);
			for (const [moduleId, group] of byModule) guarded(group, () => resolveModule(viewer, moduleId, group));
		}
		await Promise.all(pending);
		return refs.map((ref) => answers.get(formatRecordRef(ref as RecordRef)) ?? unavailable(ref.kind, ref.id));
	};
}
