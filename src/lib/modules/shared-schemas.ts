import { z } from "zod";
import type { RecordKind } from "./module-types";
import type { CapabilitySchemas } from "./schema-utils";

const json = z.record(z.string(), z.unknown());
const instant = z.string().datetime({ offset: true });

/** Input and output of a module's `resolveRefs` capability (spec §5). */
export function resolveRefsSchemas(kinds: [RecordKind, ...RecordKind[]]): CapabilitySchemas {
	const kind = z.enum(kinds);
	return {
		input: z.object({ refs: z.array(z.object({ kind, id: z.string().min(1).max(160) })).max(100) }),
		output: z.object({
			results: z.array(
				z.union([
					z.object({ kind, id: z.string(), href: z.string().nullable(), label: z.string() }),
					z.object({ kind, id: z.string(), unavailable: z.literal(true) }),
				]),
			),
		}),
	};
}

/** The lines an approval card shows for a proposed tool call, from the module's `approval.preview` service. */
export const approvalPreviewOutputSchema = z.object({
	items: z
		.array(z.object({ label: z.string().max(300), detail: z.string().max(1_000).nullable() }))
		.min(1)
		.max(20),
	/** The state of the records the lines describe; core refuses the approval when it differs by then. */
	version: z.string().max(4_000).optional(),
});

export const searchSchemas: CapabilitySchemas = {
	input: z.object({ query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(20).default(5) }),
	output: z.object({
		items: z.array(
			z.object({
				ref: z.object({ kind: z.string(), id: z.string() }),
				label: z.string(),
				sublabel: z.string(),
				href: z.string(),
			}),
		),
	}),
};

const stepMessage = z.object({
	id: z.string(),
	mailboxId: z.string(),
	from: z.string(),
	subject: z.string().nullable(),
	receivedAt: instant,
});
const stepFacts = z.object({
	authPassed: z.boolean(),
	bulk: z.boolean(),
	knownContact: z.boolean(),
	phishing: z.array(z.string()),
});
const stepAttachments = z.array(
	z.object({
		id: z.string(),
		contentType: z.string(),
		filename: z.string().nullable(),
		size: z.number().int().min(0),
	}),
);

const stepOutput = z.object({
	// Core keeps the first three valid suggestions; the cap here only bounds a runaway answer.
	suggestions: z
		.array(
			z.object({
				kind: z.string(),
				payload: json,
				reason: z.string(),
				/** Core strips controls and bidi characters and keeps 120 characters; without one the kind's label is used. */
				title: z.string().max(1_000).optional(),
			}),
		)
		.max(50),
	skipped: z.string().optional(),
});

/**
 * The step input without the sender name, text excerpt, extra facts and headers. A step validating
 * against it receives exactly these keys, because zod strips the ones core adds for wider steps.
 */
export const baseTriageStepSchemas: CapabilitySchemas = {
	input: z.object({ message: stepMessage, facts: stepFacts, attachments: stepAttachments, model: json.nullable() }),
	output: stepOutput,
};

/** The full triage-step input: excerpt, extra facts and list headers, for module steps that read them. */
export const triageStepSchemas: CapabilitySchemas = {
	input: z.object({
		message: stepMessage.extend({
			fromName: z.string().nullable(),
			/** At most 8,192 characters of the readable body text; null when the message has none. */
			textExcerpt: z.string().max(8_192).nullable(),
		}),
		facts: stepFacts.extend({
			automatic: z.boolean(),
			noReply: z.boolean(),
			list: z.boolean(),
			spam: z.boolean(),
		}),
		headers: z.object({
			listUnsubscribe: z.string().nullable(),
			listUnsubscribePost: z.string().nullable(),
			listId: z.string().nullable(),
		}),
		attachments: stepAttachments,
		model: json.nullable(),
	}),
	output: stepOutput,
};

/** Execute, undo and the pre-undo check share one capability: `op` selects, and the handler must be idempotent by `actionId`. */
export const actionSchemas: CapabilitySchemas = {
	input: z.discriminatedUnion("op", [
		z.object({
			op: z.literal("execute"),
			actionId: z.string(),
			suggestion: json,
			input: json.optional(),
			/** Effect ids a resumed row already holds (rows written before module actions derive ids from `actionId`); handlers prefer them. */
			storedIds: z.record(z.string(), z.string()).optional(),
			/**
			 * The `before` the caller saved with the pending row, on the first run and again on resume, when
			 * the record may already hold this action's changes; handlers derive their inverse from it.
			 */
			before: json.optional(),
		}),
		z.object({ op: z.literal("undo"), actionId: z.string(), inverse: json }),
		/** Asked before an undo claims anything: a handler that refuses here changes nothing. */
		z.object({ op: z.literal("authorize_undo"), actionId: z.string(), inverse: json }),
	]),
	output: z.object({
		result: json,
		inverse: json.nullable(),
		/** The handler declined: core records the action as failed, or refuses the undo with this status. */
		refused: z.object({ status: z.union([z.literal(403), z.literal(409)]), error: z.string() }).optional(),
	}),
};

export function lifecycleSchemas(event: "user.created" | "user.time_zone_changed"): CapabilitySchemas {
	const userId = z.string().min(1);
	return {
		input:
			event === "user.created"
				? z.object({ type: z.literal(event), userId })
				: z.object({
						type: z.literal(event),
						userId,
						from: z.string().nullable(),
						to: z.string(),
					}),
		output: z.object({ handled: z.boolean() }),
	};
}

/** The shape of a webhook payload: a record ref plus a minimal record. */
export { instant as instantSchema };
