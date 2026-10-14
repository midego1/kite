import type { z } from "zod";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { buildCallContext } from "@/lib/modules/capability-utils";
// Loaded for its side effect: it binds `moduleHost.actions` to the executor.
import "@/lib/modules/invoke";
import { moduleHost } from "@/lib/modules/host";
import type { HostActionCall, HostMessageDetail } from "@/lib/modules/host-types";
import type { CapabilityCallContext, JsonValue } from "@/lib/modules/module-types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { bodyError } from "./api-schemas";
import { dayInTimeZone } from "./date-utils";
import { MIGRATION_PENDING_ERROR, refusalOf } from "./errors";
import { NO_MAILBOX_ERROR, type ManagedMailbox } from "./manual-utils";

/** The signed-in user a Money Watch route acts for. */
export type FinanceUser = {
	id: string;
	email: string;
	role: string;
	isPrimaryAdmin: boolean;
	timeZone: string | null;
};

/** A route's answer: the HTTP status and the JSON body. */
export type FinanceAnswer = { status: number; body: Record<string, unknown> };

export const ok = (body: Record<string, unknown>): FinanceAnswer => ({ status: 200, body });
export const fail = (status: number, error: string, code?: string): FinanceAnswer => ({
	status,
	body: code ? { error, code } : { error },
});
export const notFound = (what = "Not found") => fail(404, what);
export const noMailbox = () => fail(409, NO_MAILBOX_ERROR, "NO_MAILBOX");

const timeZoneOf = (user: FinanceUser) => normalizeTimeZone(user.timeZone);

export const todayFor = (user: FinanceUser) => dayInTimeZone(new Date().toISOString(), timeZoneOf(user));

/** The call context of a session request; `mailboxIds` binds host reads to the named mailboxes. */
export function sessionContext(user: FinanceUser, mailboxIds?: string[]): CapabilityCallContext {
	return buildCallContext({
		trigger: "api",
		viewer: { userId: user.id, role: user.role, isPrimaryAdmin: user.isPrimaryAdmin },
		timeZone: timeZoneOf(user),
		...(mailboxIds ? { mailboxIds } : {}),
	});
}

/** The mailboxes the user has full access to: their own and shared ones with full access. */
export async function managedMailboxes(user: FinanceUser): Promise<ManagedMailbox[]> {
	const mailboxes = await listAccessibleMailboxes(getDb(getEnv()), {
		id: user.id,
		email: user.email,
		role: user.role as Parameters<typeof listAccessibleMailboxes>[1]["role"],
	});
	return mailboxes
		.filter((mailbox) => mailbox.permission === "full_access")
		.map((mailbox) => ({ id: mailbox.id, createdAt: mailbox.createdAt }));
}

export const manages = (managed: readonly ManagedMailbox[], mailboxId: string) =>
	managed.some((mailbox) => mailbox.id === mailboxId);

/** A message in a mailbox the user manages, with the list headers the cancel link comes from; null otherwise. */
export async function managedMessage(
	user: FinanceUser,
	managed: readonly ManagedMailbox[],
	messageId: string,
	text?: { maxBytes: number },
): Promise<HostMessageDetail | null> {
	const message = await moduleHost.mail.getMessage(sessionContext(user), messageId, {
		...(text ? { text } : {}),
		headers: ["list-unsubscribe", "list-unsubscribe-post"],
	});
	return message && manages(managed, message.mailboxId) ? message : null;
}

export type Parsed<T> = { data: T } | { answer: FinanceAnswer };

export function parseBody<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
	const parsed = schema.safeParse(raw);
	return parsed.success ? { data: parsed.data } : { answer: fail(400, bodyError(parsed.error)) };
}

export type Executed = { actionId: string; result: Record<string, JsonValue> } | { answer: FinanceAnswer };

/** Runs one Money Watch action through the executor as the user, so it is audited and undoable. */
export async function executeFinanceAction(
	user: FinanceUser,
	call: Omit<HostActionCall, "input"> & { input: object },
): Promise<Executed> {
	const executed = await moduleHost.actions.execute(sessionContext(user), "finance", {
		...call,
		input: call.input as Record<string, JsonValue>,
	});
	if (!executed.ok) return { answer: fail(executed.status, executed.error) };
	return { actionId: executed.actionId, result: (executed.result ?? {}) as Record<string, JsonValue> };
}

/** Answers a refusal (before migration 0063: 409 `MIGRATION_PENDING`) instead of failing the request. */
export async function answering(run: () => Promise<FinanceAnswer>): Promise<FinanceAnswer> {
	try {
		return await run();
	} catch (error) {
		const refusal = refusalOf(error);
		if (!refusal) throw error;
		return refusal.error === MIGRATION_PENDING_ERROR
			? fail(409, refusal.error, "MIGRATION_PENDING")
			: fail(refusal.status, refusal.error);
	}
}
