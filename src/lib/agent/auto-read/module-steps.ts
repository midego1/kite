import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, type messages } from "@/db/schema";
import { buildCallContext } from "@/lib/modules/capability-utils";
import { MODULE_CAPABILITIES, findDescriptor } from "@/lib/modules/capability-registry";
import { capabilityInputSchema, invokeCapability, isModuleEnabled } from "@/lib/modules/invoke";
import type { CapabilityCallContext, JsonValue, ModuleId } from "@/lib/modules/module-types";
import type { MessageFacts } from "./facts-types";
import { triageStepsFor, validateStepOutput, type TriageStep } from "./module-steps-utils";
import type { AutoReadCapabilities } from "./settings-types";
import type { PlannedSuggestion } from "./suggestion-types";

type SourceMessage = typeof messages.$inferSelect;

/** The mailbox capability switch that turns a module's step on; a module absent here always runs its step. */
const STEP_CAPABILITY: Partial<Record<ModuleId, keyof AutoReadCapabilities>> = { calendar: "calendar" };

type StepViewer = NonNullable<CapabilityCallContext["viewer"]> & { timeZone: string };

export type StepRunInput = {
	env: CloudflareEnv;
	job: { mailboxId: string };
	reviewer: StepViewer;
	source: SourceMessage;
	facts: MessageFacts;
	capabilities: AutoReadCapabilities;
	/** The triage model's answer, or null when the message needed no model call. */
	model: unknown;
};

export type StepRun = {
	planned: PlannedSuggestion[];
	/** Modules whose step was due but skipped because the module is off for the reviewer. */
	skipped: ModuleId[];
};

function dueSteps(input: StepRunInput): TriageStep[] {
	return triageStepsFor(MODULE_CAPABILITIES).filter((step) => {
		if (step.requires === "invite_attachment" && input.facts.inviteAttachments.length === 0) return false;
		const capability = STEP_CAPABILITY[step.moduleId];
		return !capability || input.capabilities[capability] === true;
	});
}

async function stepInput(input: StepRunInput): Promise<JsonValue> {
	const { source, facts } = input;
	const attachments = await getDb(input.env)
		.select({
			id: messageAttachments.id,
			contentType: messageAttachments.contentType,
			filename: messageAttachments.filename,
			size: messageAttachments.size,
		})
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, source.id));
	return JSON.parse(
		JSON.stringify({
			message: {
				id: source.id,
				mailboxId: input.job.mailboxId,
				from: source.fromAddr,
				subject: source.subject,
				receivedAt: source.createdAt.toISOString(),
			},
			facts: {
				authPassed: facts.authPassed,
				bulk: facts.bulk,
				knownContact: facts.knownContact,
				phishing: facts.phishingSignals,
			},
			attachments,
			model: input.model ?? null,
		}),
	) as JsonValue;
}

function kindSchemas(moduleId: ModuleId) {
	const capabilities = MODULE_CAPABILITIES.find((entry) => entry.moduleId === moduleId)?.descriptors ?? [];
	const kinds = capabilities.flatMap((descriptor) =>
		descriptor.surfaces.includes("suggestion_kind") && descriptor.suggestionKind
			? [{ kind: descriptor.suggestionKind.kind, name: descriptor.name }]
			: [],
	);
	return {
		ownedKinds: kinds.map((entry) => entry.kind),
		payloadSchemaFor: (kind: string) => {
			const name = kinds.find((entry) => entry.kind === kind)?.name;
			return name ? capabilityInputSchema(moduleId, name) : null;
		},
	};
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
	const steps = dueSteps(input);
	if (steps.length === 0) return { planned, skipped };
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
	return { planned, skipped };
}
