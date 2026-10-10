import type { MailboxOption } from "@/components/mailbox-provider";
import { API_KEY_MAX_MAILBOXES } from "@/lib/api/scopes";

/**
 * The mailboxes an app password starts with: every accessible mailbox, as a mail
 * app expects, or only the current one when that would exceed the per-key limit.
 */
export function defaultAppPasswordMailboxIds(
	mailboxes: Pick<MailboxOption, "id">[],
	selectedMailboxId: string | null | undefined,
): string[] {
	if (mailboxes.length <= API_KEY_MAX_MAILBOXES) return mailboxes.map((mailbox) => mailbox.id);
	const fallback = mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? mailboxes[0];
	return fallback ? [fallback.id] : [];
}

export function toggleMailboxId(ids: string[], id: string, checked: boolean): string[] {
	if (!checked) return ids.filter((item) => item !== id);
	return ids.includes(id) ? ids : [...ids, id];
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * The message to show for an API error body. Routes answer either a string or
 * zod's `flatten()` output (`{ formErrors, fieldErrors }`) for invalid input.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
	if (typeof error === "string" && error.trim()) return error;
	if (!error || typeof error !== "object") return fallback;
	const { formErrors, fieldErrors } = error as { formErrors?: unknown; fieldErrors?: unknown };
	const messages = isStringList(formErrors) ? [...formErrors] : [];
	if (fieldErrors && typeof fieldErrors === "object")
		for (const [field, errors] of Object.entries(fieldErrors))
			if (isStringList(errors)) messages.push(...errors.map((message) => `${field}: ${message}`));
	return messages.length ? messages.join("; ") : fallback;
}
