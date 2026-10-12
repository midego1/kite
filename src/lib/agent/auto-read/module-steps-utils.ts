import type { z } from "zod";
import type { CapabilityDescriptor, ModuleCapabilities, ModuleId } from "@/lib/modules/module-types";
import type { PlannedSuggestion } from "./suggestion-types";

/** A step may add this many suggestions to one message; the rest of its answer is dropped. */
const MAX_STEP_SUGGESTIONS = 3;

export const MODULE_SKIP_PREFIX = "module_disabled:";
const MAX_REASON_CHARS = 100;

type StepRejection = { kind: string; why: "kind" | "payload" | "limit" | "shape" };

export type StepValidation = { accepted: PlannedSuggestion[]; rejected: StepRejection[] };

type ValidateInput = {
	moduleId: ModuleId;
	/** The kinds the module declares as `suggestion_kind` descriptors. */
	ownedKinds: readonly string[];
	payloadSchemaFor(kind: string): z.ZodType | null;
	output: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Checks a module step's answer. Only the module's own kinds pass, each payload must match the kind's
 * schema, and at most three suggestions are kept. Only `kind`, `payload` and `reason` are read, so a
 * message id or any other field a module adds is dropped: the message is always core's.
 */
export function validateStepOutput(input: ValidateInput): StepValidation {
	const drafts = asRecord(input.output)?.suggestions;
	const accepted: PlannedSuggestion[] = [];
	const rejected: StepRejection[] = [];
	if (!Array.isArray(drafts)) return { accepted, rejected };
	for (const entry of drafts) {
		const draft = asRecord(entry);
		const kind = draft?.kind;
		if (!draft || typeof kind !== "string" || typeof draft.reason !== "string") {
			rejected.push({ kind: typeof kind === "string" ? kind : "", why: "shape" });
			continue;
		}
		if (!input.ownedKinds.includes(kind)) {
			rejected.push({ kind, why: "kind" });
			continue;
		}
		const parsed = input.payloadSchemaFor(kind)?.safeParse(draft.payload);
		if (!parsed?.success) {
			rejected.push({ kind, why: "payload" });
			continue;
		}
		if (accepted.length >= MAX_STEP_SUGGESTIONS) {
			rejected.push({ kind, why: "limit" });
			continue;
		}
		accepted.push({
			kind,
			payload: parsed.data,
			reason: draft.reason.slice(0, MAX_REASON_CHARS),
			autoExecute: false,
		} as PlannedSuggestion);
	}
	return { accepted, rejected };
}

/** The code recorded on a job whose step was skipped because its module is off; it carries the module id. */
export function stepSkipReason(moduleId: ModuleId): string {
	return `${MODULE_SKIP_PREFIX}${moduleId}`;
}

export function joinSkipReasons(moduleIds: readonly ModuleId[]): string | null {
	return moduleIds.length > 0 ? moduleIds.map(stepSkipReason).join(",") : null;
}

export function splitSkipReasons(reason: string): string[] {
	return reason.split(",").filter(Boolean);
}

const isKindDescriptor = (descriptor: CapabilityDescriptor) =>
	descriptor.surfaces.includes("suggestion_kind") && !!descriptor.suggestionKind;

/**
 * Suggestion kind to the module that declares it.
 * @public Consumed by tests that check the registry.
 */
export function suggestionKindOwners(all: readonly ModuleCapabilities[]): Record<string, ModuleId> {
	const owners: Record<string, ModuleId> = {};
	for (const entry of all)
		for (const descriptor of entry.descriptors)
			if (isKindDescriptor(descriptor)) owners[descriptor.suggestionKind!.kind] = entry.moduleId;
	return owners;
}

/** Suggestion kind to the module capability that handles an accept click on it. */
export function suggestionAnswerers(
	all: readonly ModuleCapabilities[],
): Record<string, { moduleId: ModuleId; capability: string }> {
	const answerers: Record<string, { moduleId: ModuleId; capability: string }> = {};
	for (const entry of all)
		for (const descriptor of entry.descriptors) {
			const kind = isKindDescriptor(descriptor) ? descriptor.suggestionKind! : null;
			if (kind?.answer) answerers[kind.kind] = { moduleId: entry.moduleId, capability: kind.answer };
		}
	return answerers;
}

/** Kinds that belong to a module that is off, which lists and counts must leave out. */
export function hiddenSuggestionKinds(all: readonly ModuleCapabilities[], enabled: Iterable<ModuleId>): string[] {
	const on = new Set(enabled);
	return Object.entries(suggestionKindOwners(all))
		.filter(([, moduleId]) => !on.has(moduleId))
		.map(([kind]) => kind);
}

export type TriageStep = {
	moduleId: ModuleId;
	capability: string;
	order: number;
	requires: "invite_attachment" | undefined;
};

/** Every module's `triage_step` descriptors in their declared order, whether or not the module is on. */
export function triageStepsFor(all: readonly ModuleCapabilities[]): TriageStep[] {
	return all
		.flatMap((entry) =>
			entry.descriptors
				.filter((descriptor) => descriptor.surfaces.includes("triage_step") && descriptor.triage)
				.map((descriptor) => ({
					moduleId: entry.moduleId,
					capability: descriptor.name,
					order: descriptor.triage!.order,
					requires: descriptor.triage!.requires,
				})),
		)
		.sort((a, b) => a.order - b.order);
}
