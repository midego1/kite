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

/** Raw MIME as a byte array, or as text in `encoding` (UTF-8 unless `base64` is named). */
export type HostImportMessage = {
	raw: string | number[];
	encoding?: "utf8" | "base64";
	filename?: string;
	/** The source's read state (IMAP `\Seen`); unset keeps the default: unread, or read for outbound mail. */
	read?: boolean;
	/** The source's starred state (IMAP `\Flagged`); unset is not starred. */
	starred?: boolean;
	/** ISO 8601 time the source received the message, the date when the message has no usable `Date` header. */
	receivedAt?: string;
};

/** `skipped` counts duplicates, `failed` the messages that could not be read or written, `errors` says why. */
export type HostImportResult = { imported: number; skipped: number; failed: number; errors: string[] };

export type HostUserProfile = { id: string; name: string; email: string; timeZone: string | null };

/** The list headers `mail.getMessage` can return, by lower-case name. */
export type HostMessageHeaderName = "list-unsubscribe" | "list-unsubscribe-post" | "list-id";

export type HostMessageOptions = {
	/** The readable body text, cut at `maxBytes` UTF-8 bytes (at most 64 KB) without splitting a character. */
	text?: { maxBytes: number };
	headers?: HostMessageHeaderName[];
};

export type HostMessageDetail = HostMessageView & {
	fromName: string | null;
	/** Present when `text` was asked for; null when the message has no text. */
	textExcerpt?: string | null;
	/** Present when `headers` was asked for; a header the message lacks is null. */
	headers?: Partial<Record<HostMessageHeaderName, string | null>>;
};

export type HostRecentFromSenderQuery = {
	mailboxId: string;
	sender: string;
	/** ISO time; only messages received strictly before it are listed. */
	before: string;
	sinceDays: number;
	limit: number;
};

export type HostSuggestion = {
	id: string;
	mailboxId: string;
	messageId: string;
	kind: string;
	status: string;
	payload: JsonValue;
	reviewerUserId: string;
};

export type HostActionCall = {
	capability: string;
	mailboxId: string;
	variant?: string;
	suggestionId?: string | null;
	messageId?: string | null;
	input: Record<string, JsonValue>;
	before?: JsonValue;
};

export type HostActionResult =
	{ ok: true; actionId: string; result: JsonValue } | { ok: false; status: 403 | 404 | 409; error: string };

export type HostNotice = { notice: string; title: string; body?: string; href?: string };

export type HostContact = { id: string; displayName: string | null };

/**
 * Whose login: `jobId` names the import job a background run is working on (core reads its owner and account), and
 * `accountId` one of the session viewer's own accounts, for requests made before a job exists.
 */
export type HostSourceLoginRequest = { jobId: string } | { accountId: string };

/**
 * The login of a connected account, for one run of an import from it. `auth` is a password today; OAuth accounts
 * (spec §15) will answer `{ kind: "xoauth2", user, accessToken }`. Never store it.
 */
export type HostSourceLogin =
	| {
			ok: true;
			login: {
				host: string;
				port: number;
				security: "tls" | "starttls";
				username: string;
				auth: { kind: "password"; password: string };
			};
	  }
	| { ok: false; reason: "removed" | "not_allowed" | "auth_failed"; message: string };

/** What `suggestions` and `actions` need from automatic reading, bound by it so this file does not import it. */
export type HostAgentServices = {
	getSuggestion(ctx: CapabilityCallContext, moduleId: ModuleId, suggestionId: string): Promise<HostSuggestion | null>;
	decideSuggestion(
		ctx: CapabilityCallContext,
		moduleId: ModuleId,
		suggestionId: string,
		status: "accepted",
	): Promise<boolean>;
	executeAction(ctx: CapabilityCallContext, moduleId: ModuleId, call: HostActionCall): Promise<HostActionResult>;
};

/**
 * The plain-function facade modules use to reach core services. Every function takes the JSON call
 * context and JSON arguments and returns JSON, so the same shape can later be an RPC surface.
 */
export type ModuleHost = {
	emitWebhook(ctx: CapabilityCallContext, moduleId: ModuleId, event: string, payload: JsonValue): Promise<void>;
	invoke(ctx: CapabilityCallContext, moduleId: ModuleId, name: string, input: JsonValue): Promise<CapabilityResult>;
	modules: { isEnabledFor(ctx: CapabilityCallContext, userId: string, moduleId: ModuleId): Promise<boolean> };
	resolveRefs(ctx: CapabilityCallContext, refs: RecordRef[]): Promise<HostResolvedRef[]>;
	suggestions: {
		/** A suggestion of a kind the module owns, if the viewer may decide it (full access, and the reviewer for `audience: "reviewer"`). */
		get(ctx: CapabilityCallContext, moduleId: ModuleId, suggestionId: string): Promise<HostSuggestion | null>;
		/** Marks an open suggestion of the module's kind accepted by the viewer and sends the quiet realtime ping. */
		decide(ctx: CapabilityCallContext, moduleId: ModuleId, suggestionId: string, status: "accepted"): Promise<boolean>;
	};
	actions: {
		/** Runs an action capability the module owns through the executor as the viewer, with the viewer's mailbox permissions. */
		execute(ctx: CapabilityCallContext, moduleId: ModuleId, call: HostActionCall): Promise<HostActionResult>;
	};
	/** A transient notice over realtime to those of `userIds` for whom the module is on. */
	notify(ctx: CapabilityCallContext, moduleId: ModuleId, userIds: string[], notice: HostNotice): Promise<void>;
	contacts: {
		/** The viewer's own contact for an address; `userId` must be the viewer. */
		find(ctx: CapabilityCallContext, userId: string, email: string): Promise<HostContact | null>;
	};
	mail: {
		getMessage(
			ctx: CapabilityCallContext,
			messageId: string,
			options?: HostMessageOptions,
		): Promise<HostMessageDetail | null>;
		/** At most 5 earlier received messages from one sender in a mailbox in `ctx.mailboxIds`, newest first, with excerpts of at most 4 KB. */
		recentFromSender(
			ctx: CapabilityCallContext,
			query: HostRecentFromSenderQuery,
		): Promise<(HostMessageView & { textExcerpt: string | null })[]>;
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
	accounts: {
		/**
		 * The login of a connected account for the import module only: the account of an active import job (`jobId`),
		 * or one of the session viewer's own accounts (`accountId`, refused without a viewer), when connected accounts
		 * are allowed for its owner; otherwise why not. Opened per run, never copied into module state.
		 */
		sourceLogin(
			ctx: CapabilityCallContext,
			moduleId: ModuleId,
			request: HostSourceLoginRequest,
		): Promise<HostSourceLogin>;
	};
	audit(ctx: CapabilityCallContext, action: string, metadata: JsonValue): Promise<void>;
};
