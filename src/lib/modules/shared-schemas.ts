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

export const triageStepSchemas: CapabilitySchemas = {
	input: z.object({
		message: z.object({
			id: z.string(),
			mailboxId: z.string(),
			from: z.string(),
			subject: z.string().nullable(),
			receivedAt: instant,
		}),
		facts: z.object({
			authPassed: z.boolean(),
			bulk: z.boolean(),
			knownContact: z.boolean(),
			phishing: z.array(z.string()),
		}),
		attachments: z.array(
			z.object({
				id: z.string(),
				contentType: z.string(),
				filename: z.string().nullable(),
				size: z.number().int().min(0),
			}),
		),
		model: json.nullable(),
	}),
	output: z.object({
		// Core keeps the first three valid suggestions; the cap here only bounds a runaway answer.
		suggestions: z.array(z.object({ kind: z.string(), payload: json, reason: z.string() })).max(50),
		skipped: z.string().optional(),
	}),
};

/** Execute, undo and the pre-undo check share one capability: `op` selects, and the handler must be idempotent by `actionId`. */
export const actionSchemas: CapabilitySchemas = {
	input: z.discriminatedUnion("op", [
		z.object({ op: z.literal("execute"), actionId: z.string(), suggestion: json, input: json.optional() }),
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
