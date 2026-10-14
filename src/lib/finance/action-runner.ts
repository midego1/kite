import type { ZodType } from "zod";
import type { CapabilityCallContext, CapabilityHandler, JsonValue } from "@/lib/modules/module-types";
import { storedInverse, type StoredInverse } from "./action-input";
import { FinanceRefusal, refusalOf } from "./errors";
import { chargeFromJson, fieldColumns, subscriptionFromJson, subscriptionRef } from "./record-utils";
import { deleteDocuments, deleteSubscriptionRow, ownerRow, restoreRows, updateSubscription } from "./subscriptions";

export type ExecuteCall<Input> = {
	actionId: string;
	userId: string;
	ctx: CapabilityCallContext;
	suggestion: { id: string | null; messageId: string | null; mailboxId: string };
	input: Input;
};

export type ActionOutcome = { result: Record<string, JsonValue>; inverse: StoredInverse | null };

type RawCall =
	| { op: "execute"; actionId: string; suggestion: ExecuteCall<unknown>["suggestion"]; input?: JsonValue }
	| { op: "undo" | "authorize_undo"; actionId: string; inverse: { inverse: JsonValue } };

/** The result every Money Watch action reports: the subscription it is about, which Activity links. */
export function actionResult(subscriptionId: string, extra: Record<string, JsonValue> = {}): Record<string, JsonValue> {
	return { ref: subscriptionRef(subscriptionId), subscriptionId, ...extra };
}

/**
 * Undoes what one action stored: deletes the row it created, puts back the fields it changed,
 * removes only the documents it inserted, and re-inserts what it removed with the same ids. Each
 * step is a no-op when already done, so a retried undo changes nothing more.
 */
async function undoStored(inverse: StoredInverse): Promise<void> {
	const { userId, subscriptionId } = inverse;
	if (inverse.created) {
		await deleteSubscriptionRow(userId, subscriptionId);
		return;
	}
	if (inverse.removed) {
		const subscription = inverse.removed.subscription ? subscriptionFromJson(inverse.removed.subscription) : null;
		await restoreRows(subscription, inverse.removed.documents.map(chargeFromJson));
	}
	if (inverse.previous && Object.keys(inverse.previous).length > 0 && (await ownerRow(userId, subscriptionId)))
		await updateSubscription(userId, subscriptionId, fieldColumns(inverse.previous));
	await deleteDocuments(userId, inverse.documentIds ?? []);
}

function undoInverse(call: Extract<RawCall, { op: "undo" | "authorize_undo" }>): StoredInverse | null {
	const parsed = storedInverse.safeParse(call.inverse?.inverse);
	return parsed.success ? parsed.data : null;
}

async function run<Input>(
	raw: JsonValue,
	ctx: CapabilityCallContext,
	schema: ZodType<Input>,
	execute: (call: ExecuteCall<Input>) => Promise<ActionOutcome>,
): Promise<JsonValue> {
	const viewer = ctx.viewer;
	if (!viewer) throw new FinanceRefusal(403, "This action needs a signed-in user");
	const call = raw as unknown as RawCall;
	if (call.op === "execute") {
		const input = schema.safeParse(call.input);
		if (!input.success) throw new FinanceRefusal(409, "The action's input is not valid");
		const { actionId, suggestion } = call;
		const outcome = await execute({ actionId, userId: viewer.userId, ctx, suggestion, input: input.data });
		// Optional inverse fields may be undefined, which is not JSON.
		const inverse = outcome.inverse ? (JSON.parse(JSON.stringify(outcome.inverse)) as JsonValue) : null;
		return { result: outcome.result, inverse };
	}
	const inverse = undoInverse(call);
	if (inverse && inverse.userId !== viewer.userId)
		throw new FinanceRefusal(403, "Only the owner can change this subscription");
	if (inverse && call.op === "undo") await undoStored(inverse);
	return { result: {}, inverse: null };
}

/**
 * The handler behind one Money Watch `action` capability. `op` selects execute, undo or the check
 * before an undo; all three are idempotent by `actionId`. Only the subscription's owner may undo,
 * and a refusal is answered, never thrown, so the executor records it.
 */
export function financeAction<Input>(
	schema: ZodType<Input>,
	execute: (call: ExecuteCall<Input>) => Promise<ActionOutcome>,
): CapabilityHandler {
	return async (raw, ctx) => {
		try {
			return await run(raw, ctx, schema, execute);
		} catch (error) {
			const refusal = refusalOf(error);
			if (!refusal) throw error;
			return {
				result: {},
				inverse: null,
				refused: { status: refusal.status === 403 ? 403 : 409, error: refusal.error },
			};
		}
	};
}

/** The owner's row an action changes; 409 when it is gone. */
export async function requireRow(userId: string, subscriptionId: string) {
	const row = await ownerRow(userId, subscriptionId);
	if (!row) throw new FinanceRefusal(409, "The subscription is no longer tracked");
	return row;
}
