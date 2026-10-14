import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, type messages } from "@/db/schema";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { MODULE_CAPABILITIES, findDescriptor } from "@/lib/modules/capability-registry";
import { invokeCapability, isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext, JsonValue, ModuleId } from "@/lib/modules/module-types";
import type { MessageFacts } from "./facts-types";
import { moduleKindPayloadSchema } from "./module-kinds";
import {
	selectDueSteps,
	stepSwitchOn,
	suggestionKindDescriptors,
	triageStepsFor,
	validateStepOutput,
	type TriageStep,
} from "./module-steps-utils";
import type { AutoReadCapabilities } from "./settings-types";
import { buildStepInput } from "./step-input-utils";
import type { PlannedSuggestion } from "./suggestion-types";

type SourceMessage = typeof messages.$inferSelect;

const TRIAGE_STEPS = triageStepsFor(MODULE_CAPABILITIES);

const MODULE_KINDS = suggestionKindDescriptors(MODULE_CAPABILITIES);

type StepViewer = NonNullable<CapabilityCallContext["viewer"]> & { timeZone: string };

export type StepRunInput = {
	env: CloudflareEnv;
	job: { mailboxId: string };
	reviewer: StepViewer;
	source: SourceMessage;
	facts: MessageFacts;
	/** The raw headers triage read, lower-case names with their first value. */
	headers: Record<string, string>;
	bodyText: string;
	capabilities: AutoReadCapabilities;
	/** The triage model's answer, or null when the model did not run or was refused. */
	model: unknown;
	/** A steps-only pass for `Auto-Submitted` mail: only steps that opted in run. */
	automaticOnly?: boolean;
};

export type StepRun = {
	planned: PlannedSuggestion[];
	/** Modules whose step was due but skipped because the module is off for the reviewer. */
	skipped: ModuleId[];
	/** How many steps were invoked. */
	ran: number;
};

function dueSteps(input: StepRunInput): TriageStep[] {
	return selectDueSteps(TRIAGE_STEPS, {
		inviteAttachments: input.facts.inviteAttachments.length,
		capabilities: input.capabilities,
		automaticOnly: input.automaticOnly === true,
	});
}

/**
 * Whether `Auto-Submitted` mail should get a triage job: some step opted in to it, its switch is on for
 * the mailbox and its module is on for the reviewer.
 */
export async function automaticStepOpen(
	reviewer: NonNullable<CapabilityCallContext["viewer"]>,
	capabilities: AutoReadCapabilities,
): Promise<boolean> {
	for (const step of TRIAGE_STEPS)
		if (step.automatic && stepSwitchOn(step, capabilities) && (await isModuleEnabled(reviewer, step.moduleId)))
			return true;
	return false;
}

async function stepInput(input: StepRunInput): Promise<JsonValue> {
	const attachments = await getDb(input.env)
		.select({
			id: messageAttachments.id,
			contentType: messageAttachments.contentType,
			filename: messageAttachments.filename,
			size: messageAttachments.size,
		})
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, input.source.id));
	return JSON.parse(
		JSON.stringify(
			buildStepInput({
				source: input.source,
				mailboxId: input.job.mailboxId,
				facts: input.facts,
				headers: input.headers,
				bodyText: input.bodyText,
				attachments,
				model: input.model,
			}),
		),
	) as JsonValue;
}

function kindSchemas(moduleId: ModuleId) {
	const ownedKinds = Object.entries(MODULE_KINDS)
		.filter(([, owner]) => owner.moduleId === moduleId)
		.map(([kind]) => kind);
	return { ownedKinds, payloadSchemaFor: moduleKindPayloadSchema };
}

/**
 * Runs the `triage_step` capabilities of the modules that are on for the reviewer, with the message's
 * facts as JSON and only the grants the step declares. A module that is off is skipped and reported,
 * and what a step returns is checked here: only its own kinds, valid payloads, at most three. A step
 * that fails to run throws so the job is retried like any other transient failure.
 */
export async function runModuleTriageSteps(input: StepRunInput): Promise<StepRun> {
	const planned: PlannedSuggestion[] = [];
	const skipped: ModuleId[] = [];
	let ran = 0;
	const steps = dueSteps(input);
	if (steps.length === 0) return { planned, skipped, ran };
	const payload = await stepInput(input);
	for (const step of steps) {
		const descriptor = findDescriptor(step.moduleId, step.capability);
		if (!descriptor || !(await isModuleEnabled(input.reviewer, step.moduleId))) {
			skipped.push(step.moduleId);
			continue;
		}
		const ctx = buildCallContext({
			trigger: "auto_read",
			viewer: {
				userId: input.reviewer.userId,
				role: input.reviewer.role,
				isPrimaryAdmin: input.reviewer.isPrimaryAdmin,
			},
			timeZone: input.reviewer.timeZone,
			mailboxIds: [input.job.mailboxId],
			grants: descriptor.scopes ?? [],
		});
		ran += 1;
		const result = await invokeCapability(step.moduleId, step.capability, payload, ctx);
		if (!result.ok) {
			if (result.error.code === "module_disabled") skipped.push(step.moduleId);
			else if (result.error.retryable) throw new Error(`The ${step.moduleId} triage step failed: ${result.error.code}`);
			continue;
		}
		planned.push(
			...validateStepOutput({ moduleId: step.moduleId, output: result.output, ...kindSchemas(step.moduleId) }).accepted,
		);
	}
	return { planned, skipped, ran };
}
