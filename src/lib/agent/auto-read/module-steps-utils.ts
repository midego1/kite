import type { z } from "zod";
import { cleanDisplayText } from "@/lib/modules/display-text-utils";
import type { CapabilityDescriptor, ModuleCapabilities, ModuleId } from "@/lib/modules/module-types";
import type { AutoReadCapabilities } from "./settings-types";
import type { PlannedSuggestion } from "./suggestion-types";

/** A step may add this many suggestions to one message; the rest of its answer is dropped. */
const MAX_STEP_SUGGESTIONS = 3;

const MODULE_SKIP_PREFIX = "module_disabled:";
const MAX_REASON_CHARS = 100;
const MAX_TITLE_CHARS = 120;

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
 * A step-supplied title as core stores it: controls and bidi characters removed, whitespace collapsed,
 * at most 120 code points. Undefined when nothing printable is left.
 * @public Consumed by tests that check the title rules directly.
 */
export function cleanStepTitle(value: unknown): string | undefined {
	return cleanDisplayText(value, MAX_TITLE_CHARS);
}

/**
 * Checks a module step's answer. Only the module's own kinds pass, each payload must match the kind's
 * schema, and at most three suggestions are kept. Only `kind`, `payload`, `reason` and `title` are read,
 * so a message id or any other field a module adds is dropped: the message is always core's.
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
		const title = cleanStepTitle(draft.title);
		accepted.push({
			kind,
			payload: parsed.data,
			reason: draft.reason.slice(0, MAX_REASON_CHARS),
			autoExecute: false,
			...(title ? { title } : {}),
		} as PlannedSuggestion);
	}
	return { accepted, rejected };
}

/** The code recorded on a job whose step was skipped because its module is off; it carries the module id. */
export function stepSkipReason(moduleId: ModuleId): string {
	return `${MODULE_SKIP_PREFIX}${moduleId}`;
}

/**
 * A finished job's note: the model's own code first (why it was not asked, or why its flag did not warn),
 * then each module whose step was skipped.
 */
export function joinSkipReasons(moduleIds: readonly ModuleId[], modelSkip: string | null = null): string | null {
	const parts = [...(modelSkip ? [modelSkip] : []), ...moduleIds.map(stepSkipReason)];
	return parts.length > 0 ? parts.join(",") : null;
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

export type SuggestionKindOwner = { moduleId: ModuleId; capability: string; label: string };

/** Suggestion kind to its module, the `suggestion_kind` descriptor whose input schema is the payload schema, and its label. */
export function suggestionKindDescriptors(all: readonly ModuleCapabilities[]): Record<string, SuggestionKindOwner> {
	const kinds: Record<string, SuggestionKindOwner> = {};
	for (const entry of all)
		for (const descriptor of entry.descriptors)
			if (isKindDescriptor(descriptor))
				kinds[descriptor.suggestionKind!.kind] = {
					moduleId: entry.moduleId,
					capability: descriptor.name,
					label: descriptor.suggestionKind!.label,
				};
	return kinds;
}

/** Kinds triage stores: the given core kinds, then every kind a module declares. */
export function storedSuggestionKinds(core: readonly string[], all: readonly ModuleCapabilities[]): string[] {
	return [...new Set([...core, ...Object.keys(suggestionKindOwners(all))])];
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

/** Kinds only the mailbox's reviewer may see and decide (`audience: "reviewer"`). */
export function reviewerOnlySuggestionKinds(all: readonly ModuleCapabilities[]): string[] {
	return all.flatMap((entry) =>
		entry.descriptors
			.filter((descriptor) => isKindDescriptor(descriptor) && descriptor.suggestionKind!.audience === "reviewer")
			.map((descriptor) => descriptor.suggestionKind!.kind),
	);
}

/** True when a reviewer-only suggestion belongs to someone else's review, so the viewer must not learn it exists. */
export function hiddenFromViewer(
	row: { kind: string; reviewerUserId: string },
	viewerId: string,
	reviewerOnly: readonly string[],
): boolean {
	return reviewerOnly.includes(row.kind) && row.reviewerUserId !== viewerId;
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
	/** The step opted in to `Auto-Submitted` mail. */
	automatic: boolean;
	/** The step's key in `capabilities.modules`, or null when it has no switch of its own. */
	switchKey: string | null;
};

/** Steps whose switch is one of the mailbox's core capability keys, from before module switches existed. */
const CORE_STEP_SWITCH: Partial<Record<ModuleId, keyof AutoReadCapabilities>> = { calendar: "calendar" };

/**
 * Whether the mailbox lets a step run: a core key for the steps that had one first, else the step's
 * key in `capabilities.modules` (on unless set to false), else always.
 */
export function stepSwitchOn(step: Pick<TriageStep, "moduleId" | "switchKey">, capabilities: AutoReadCapabilities) {
	const core = Object.hasOwn(CORE_STEP_SWITCH, step.moduleId) ? CORE_STEP_SWITCH[step.moduleId] : undefined;
	if (core) return capabilities[core] === true;
	if (!step.switchKey) return true;
	return capabilities.modules?.[step.switchKey] !== false;
}

/**
 * The steps due for a message: switched on for the mailbox, with their required fact present, and on a
 * steps-only pass for `Auto-Submitted` mail only those that opted in.
 */
export function selectDueSteps(
	steps: readonly TriageStep[],
	input: { inviteAttachments: number; capabilities: AutoReadCapabilities; automaticOnly: boolean },
): TriageStep[] {
	return steps.filter((step) => {
		if (input.automaticOnly && !step.automatic) return false;
		if (step.requires === "invite_attachment" && input.inviteAttachments === 0) return false;
		return stepSwitchOn(step, input.capabilities);
	});
}

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
					automatic: descriptor.triage!.automatic === true,
					switchKey: descriptor.triage!.capability ?? null,
				})),
		)
		.sort((a, b) => a.order - b.order);
}
