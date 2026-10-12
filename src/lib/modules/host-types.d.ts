import type { CapabilityCallContext, CapabilityResult, JsonValue, ModuleId, RecordRef } from "./module-types";

export type HostResolvedRef =
	| { kind: string; id: string; href: string | null; label: string }
	| { kind: string; id: string; unavailable: true; label: string };

export type HostMessageView = {
	id: string;
	mailboxId: string;
	from: string;
	subject: string | null;
	receivedAt: string;
	attachments: { id: string; contentType: string; filename: string | null; size: number }[];
};

export type HostAttachmentContent = { encoding: "text" | "base64"; content: string; truncated: boolean };

export type HostDraft = {
	mailboxId: string;
	/** The From address; empty or missing means the mailbox's own address. */
	from?: string;
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	html?: string;
	/** Id of the stored message this one answers; threading headers come from it. */
	inReplyToMessageId?: string;
	/** Caller-chosen id for the stored message, so a retried caller finds the row it already wrote. */
	messageId?: string;
	/** ISO time for a delayed send; a past time sends at once. */
	scheduledAt?: string;
	/** An iCalendar part sent alongside the text, for invitations and RSVP replies. */
	calendar?: { method?: string; content: string };
};

export type HostImportMessage = { raw: string | number[]; receivedAt?: string };

export type HostImportResult = { imported: number; skipped: number; failed: number };

export type HostUserProfile = { id: string; name: string; email: string; timeZone: string | null };

/**
 * The plain-function facade modules use to reach core services. Every function takes the JSON call
 * context and JSON arguments and returns JSON, so the same shape can later be an RPC surface.
 */
export type ModuleHost = {
	emitWebhook(ctx: CapabilityCallContext, moduleId: ModuleId, event: string, payload: JsonValue): Promise<void>;
	invoke(ctx: CapabilityCallContext, moduleId: ModuleId, name: string, input: JsonValue): Promise<CapabilityResult>;
	modules: { isEnabledFor(ctx: CapabilityCallContext, userId: string, moduleId: ModuleId): Promise<boolean> };
	resolveRefs(ctx: CapabilityCallContext, refs: RecordRef[]): Promise<HostResolvedRef[]>;
	mail: {
		getMessage(ctx: CapabilityCallContext, messageId: string): Promise<HostMessageView | null>;
		readAttachment(
			ctx: CapabilityCallContext,
			messageId: string,
			attachmentId: string,
			options: { maxBytes: number },
		): Promise<HostAttachmentContent | null>;
		send(ctx: CapabilityCallContext, draft: HostDraft): Promise<{ messageId: string }>;
		importMessages(
			ctx: CapabilityCallContext,
			request: { userId: string; mailboxId: string; destination: string; messages: HostImportMessage[] },
		): Promise<HostImportResult>;
	};
	users: { getProfile(ctx: CapabilityCallContext, userId: string): Promise<HostUserProfile | null> };
	audit(ctx: CapabilityCallContext, action: string, metadata: JsonValue): Promise<void>;
};
