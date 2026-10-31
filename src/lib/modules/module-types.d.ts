export type ModuleId = "calendar" | "booking" | "templates" | "import" | "finance" | "drive";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchemaObject = { [key: string]: JsonValue };

/** `<namespace>:<type>`; core kinds are owned by core, the rest by the module named by the namespace. */
export type RecordKind =
	| "mail:message"
	| "mail:thread"
	| "mail:mailbox"
	| "user:user"
	| "contact:contact"
	| "calendar:event"
	| "booking:event_type"
	| "booking:appointment"
	| "templates:template"
	| "import:job"
	| "finance:subscription"
	| "drive:file";

export type RecordRef = { kind: RecordKind; id: string };

export type ModuleNavPlacement =
	"mailbox-selector" | "account-menu" | "module-tabs" | "settings-nav" | "admin-nav" | "sidebar";

export type ModuleNavItem = {
	id: string;
	label: string;
	href: string;
	/** Resolved by the client registry, so the manifest stays data. */
	icon: string;
	placement: ModuleNavPlacement;
	/** The menu group (its label) for `settings-nav` and `admin-nav` items; admin items need an admin to see them. */
	group?: string;
	/** A `{ count }` endpoint under one of the module's API prefixes, shown next to a `sidebar` item. */
	count?: { endpoint: string };
	keywords?: string[];
	order: number;
};

export type UiCommandEffect = "navigate" | "read" | "fill" | "create" | "update" | "delete";
export type UiCommandClientAction = "open_view" | "apply_filter" | "open_dialog" | "fill_form" | "invoke";

export type UiCommand = {
	id: string;
	moduleId: ModuleId | "core";
	label: string;
	description: string;
	keywords?: string[];
	group: string;
	params?: JsonSchemaObject;
	target: { type: "route"; href: string } | { type: "client"; action: UiCommandClientAction; handler: string };
	effect: UiCommandEffect;
	shortcut?: string;
};

/** What a client command handler may use; it runs in the tab with the user's own session. */
export type CommandParamValues = Record<string, JsonValue>;
export type CommandHandlerContext = { navigate: (href: string) => void; params: CommandParamValues };
export type CommandHandler = (context: CommandHandlerContext) => void | Promise<void>;
export type CommandParamField = { name: string; required: boolean; hint?: string };

export type CoreShortcutChrome = "togglePalette" | "toggleHelp" | "focusSearch" | "dismiss";

/** A key binding core owns: it runs a listed command, or one of the palette shell's own actions. */
export type CoreShortcut = {
	key: string;
	label: string;
	category: "Navigation" | "Actions" | "Composing" | "Selection" | "General";
	modifiers?: ("ctrl" | "meta" | "alt" | "shift")[];
} & ({ commandId: string; chrome?: undefined } | { chrome: CoreShortcutChrome; commandId?: undefined });

export type ComposerSlotDeclaration = {
	id: string;
	slot: "send-menu";
	order: number;
	label: string;
};

/** What a module declares of the composer slots, as far as listing them goes. */
export type ComposerSlotSource = { id: ModuleId; composerSlots?: readonly ComposerSlotDeclaration[] };
export type ListedComposerSlot = ComposerSlotDeclaration & { moduleId: ModuleId };

/** An entry in the reader's overflow menu; core draws `label`, and the module's slot component gets only the message and mailbox ids. */
export type MessageSlotDeclaration = {
	id: string;
	slot: "message-menu";
	order: number;
	label: string;
	/** A lucide icon name, resolved by the client registry like `nav[].icon`. */
	icon?: string;
};

export type MessageSlotSource = { id: ModuleId; messageSlots?: readonly MessageSlotDeclaration[] };
export type ListedMessageSlot = MessageSlotDeclaration & { moduleId: ModuleId };

/** An entry in the menu of one attachment in the reader; core draws `label`, and the module's slot component gets only the message, mailbox and attachment ids. */
export type AttachmentSlotDeclaration = {
	id: string;
	slot: "attachment-menu";
	order: number;
	label: string;
	/** A lucide icon name, resolved by the client registry like `nav[].icon`. */
	icon?: string;
};

export type AttachmentSlotSource = { id: ModuleId; attachmentSlots?: readonly AttachmentSlotDeclaration[] };
export type ListedAttachmentSlot = AttachmentSlotDeclaration & { moduleId: ModuleId };

/** A card in the empty reading pane (the command center); the module draws the whole card and gets only the selected mailbox id. */
export type ReadingPaneSlotDeclaration = {
	id: string;
	slot: "reading-pane";
	order: number;
};

export type ReadingPaneSlotSource = { id: ModuleId; readingPaneSlots?: readonly ReadingPaneSlotDeclaration[] };
export type ListedReadingPaneSlot = ReadingPaneSlotDeclaration & { moduleId: ModuleId };

/** One key scope as the key-creation forms show it. */
export type KeyScopeText = { scope: string; label: string; description: string };

/** How the shared suggestion surfaces show one module-owned kind. */
export type SuggestionKindMeta = {
	/** The For you heading of the kind's group. */
	label: string;
	/** Reason code (a suggestion's `reason`) to the plain words "Why?" shows. */
	reason: Record<string, string>;
	/** Rank among the kinds that earn a row chip, lower first (core: phishing 10, reply 30, task 40, receipt 50); no chip without one. */
	badgePriority?: number;
	/** The chip's short text; the `label` when absent. */
	badgeLabel?: string;
	/** A lucide icon name for the chip, resolved by the client registry like `nav[].icon`. */
	icon?: string;
};

/** The part of a manifest that browser code needs: identity, navigation and commands. */
export type ClientModuleData = Pick<ModuleManifest, "id" | "name" | "nav" | "commands"> & {
	/** Composer slots the module fills, so the composer lists them without loading the module. */
	composerSlots?: ComposerSlotDeclaration[];
	/** Message menu slots the module fills, so the reader lists them without loading the module. */
	messageSlots?: MessageSlotDeclaration[];
	/** Attachment menu slots the module fills, so the reader lists them without loading the module. */
	attachmentSlots?: AttachmentSlotDeclaration[];
	/** Cards the module adds to the empty reading pane, so the command center lists them without loading the module. */
	readingPaneSlots?: ReadingPaneSlotDeclaration[];
	/** Suggestion kinds the module's `suggestion_kind` capabilities declare, so the reader card can pick the module's client chunk without the registry. */
	suggestionKinds?: readonly string[];
	/** Label, reasons, chip rank and icon per kind in `suggestionKinds`, so core surfaces need no per-kind code. */
	suggestionKindMeta?: Readonly<Record<string, SuggestionKindMeta>>;
	/** The per-mailbox switches of the module's triage steps (`triage.capability` keys), listed in the automatic-reading settings while the module is on. */
	triageSwitches?: readonly { key: string; label: string }[];
	/** The key scopes the module adds, with the form text for each, so the key forms can list them only while it is on. */
	keyScopes?: { mcp: readonly (KeyScopeText & { mailboxBound: boolean })[]; api: readonly KeyScopeText[] };
};

export type ModuleWebhookEvent = { value: string; label: string; hint: string };

export type ModuleQueueName = "inbound" | "outbound" | "agent";
export type ModuleCronSchedule = "every_tick" | "*/5 * * * *" | "0 2 * * *";

export type ModuleManifest = {
	id: ModuleId;
	name: string;
	description: string;
	/** "sandboxed" is reserved for signed bundles that run inside the install; no builtin uses it. */
	runtime: "builtin" | "sandboxed";
	dependsOn: ModuleId[];
	/** Used only when `module_settings` has no row. */
	defaultEnabled: boolean;
	pages: { prefix: string; public?: boolean }[];
	apiPrefixes: { prefix: string; public?: boolean }[];
	nav: ModuleNavItem[];
	commands: UiCommand[];
	composerSlots: ComposerSlotDeclaration[];
	messageSlots?: MessageSlotDeclaration[];
	attachmentSlots?: AttachmentSlotDeclaration[];
	readingPaneSlots?: ReadingPaneSlotDeclaration[];
	recordKinds: { kind: RecordKind; label: string; unavailableLabel: string }[];
	webhookEvents: ModuleWebhookEvent[];
	grants: { grant: string; label: string }[];
	mcpScopes: { scope: string; label: string; grants: string[]; mailboxBound: boolean }[];
	apiKeyScopes: { scope: string; label: string; grants: string[] }[];
	/** JMAP capability URNs the module adds to the session; none of the builtin modules declares one. */
	jmapCapabilities: string[];
	searchSections: { id: string; label: string }[];
	/** Message statuses the module owns, hidden from lists unless the module is enabled. */
	messageStatuses: string[];
	queueMessageTypes: { kind: string; queue: ModuleQueueName; capability: string; metricClass: string }[];
	cronTasks: { name: string; schedule: ModuleCronSchedule; capability: string }[];
	/** Agent action type (or `type:variant`) to its Activity label. */
	actionLabels: Record<string, string>;
	/** Skip or suggestion reason code to plain words. */
	reasonTexts: Record<string, string>;
	adminNotes?: string[];
};

export type CapabilitySurface =
	| "assistant_tool"
	| "mcp_tool"
	| "search"
	| "resolve_refs"
	| "suggestion_kind"
	| "triage_step"
	| "action"
	| "webhook_event"
	| "lifecycle"
	| "cron"
	| "queue"
	| "jmap_capability"
	| "jmap_method"
	| "service"
	| "storage_hook";

export type CapabilityEffect = "none" | "read" | "create" | "update" | "delete" | "send" | "external";

/**
 * A triage step's addition to the one triage model request, as static JSON data. Core merges `jsonSchema`
 * under `properties.modules.properties.<moduleId>` of the provider schema, appends `instructions` to the
 * prompt's key list and hands the step back whatever the model answered under its id, unvalidated.
 */
export type TriageModelExtension = {
	/** An object schema with `additionalProperties: false` and only scalar, nullable or enum properties; at most 2 KB. */
	jsonSchema: JsonSchemaObject;
	/** At most 600 printable characters, no newline, `<<<` or `nonce=`. */
	instructions: string;
	/** Extra output tokens, 1..200; the total across extensions is capped at 200. */
	maxOutputTokens: number;
	/** A `service` capability of the same module answering `{ wantsModel: boolean }` for the step input. */
	wantsModel?: string;
};

export type CapabilityDescriptor = {
	name: string;
	surfaces: CapabilitySurface[];
	description: string;
	inputSchema: JsonSchemaObject;
	outputSchema?: JsonSchemaObject;
	/** Grants the caller must hold, all of them. */
	scopes?: string[];
	effect: CapabilityEffect;
	/** The input names a mailbox that `ctx.mailboxIds` must include. */
	mailboxBound?: boolean;
	timeoutMs?: number;
	search?: { section: string };
	refs?: { kinds: RecordKind[] };
	/**
	 * `answer` names the `service` capability that handles an accept click on this kind of suggestion.
	 * `audience: "reviewer"` shows and lets decide the suggestion only to the mailbox's reviewer, not to
	 * everyone with full access (default `mailbox`).
	 */
	suggestionKind?: {
		kind: string;
		label: string;
		reasonTemplate: string;
		answer?: string;
		audience?: "mailbox" | "reviewer";
	};
	/**
	 * `requires` names a fact core checks first: the step is neither run nor recorded as skipped without it.
	 * `automatic` lets `Auto-Submitted` mail reach the step through a steps-only pass. `capability` names
	 * the key of the step's per-mailbox switch in `capabilities.modules` (on unless set to false).
	 */
	triage?: {
		order: number;
		requires?: "invite_attachment";
		automatic?: true;
		capability?: string;
		model?: TriageModelExtension;
	};
	action?: {
		actionType: string;
		suggestionKind?: string;
		undoable: boolean;
		undoWindowMs?: number;
		/** The mailbox permission executing and undoing need. */
		permission?: "manage" | "send_on_behalf";
		/** Allowed `variant` values; `""` for an action with a single outcome. */
		variants?: string[];
		/** Only the user who ran the action may undo it. */
		actingUserOnly?: boolean;
		/** The action type an undo is recorded as, when it differs from the action. */
		inverseAction?: string;
		/** Variants whose undo restores state in place, so they record no inverse action. */
		inverseSkipVariants?: string[];
		/** After an undo, core reopens the suggestion once no live action of this module remains on it. */
		reopensSuggestion?: boolean;
	};
	/**
	 * An assistant tool the user approves in chat before it runs (a tool whose effect is `update`, `delete` or
	 * `send` always needs it). `preview` names a `service` capability of the same module that core calls with
	 * `{ tool, input }` and that answers `{ items: { label, detail }[], version? }`: the lines the approval card
	 * shows, and the state of the records they describe, which core checks again before running an approval.
	 */
	approval?: { preview: string };
	event?: { value: string };
	lifecycle?: { event: "user.created" | "user.time_zone_changed"; dataHook: boolean };
	cron?: { task: string };
	queue?: { kind: string };
	/**
	 * How core storage reaches objects a module owns, for store migrations and store deletion. Like a data
	 * hook it runs while the module is off, because the module's objects still exist and still have to move.
	 */
	storage?: { objectClass: "drive"; hook: StorageHookName };
	jmap?: { urn?: string; capability?: JsonValue; method?: string };
};

/** `listObjectKeys` pages `{ id, key, size }` on a store; `markMoved` records rows copied to another store; `countOnStore` and `usage` count them. */
export type StorageHookName = "listObjectKeys" | "markMoved" | "countOnStore" | "usage";

export type ModuleCapabilities = {
	moduleId: ModuleId;
	/** Static text with `{timeZone}` and `{today}` placeholders that core fills. */
	promptFragment: string | null;
	descriptors: CapabilityDescriptor[];
};

export type CapabilityTrigger = "chat" | "auto_read" | "mcp" | "api" | "cron" | "queue" | "webhook" | "system";

export type CapabilityCallContext = {
	viewer: { userId: string; role: string; isPrimaryAdmin: boolean } | null;
	requestId: string;
	locale: string;
	timeZone: string;
	grants: string[];
	mailboxIds?: string[];
	trigger: CapabilityTrigger;
};

export type CapabilityErrorCode =
	| "unknown_capability"
	| "module_disabled"
	| "forbidden"
	| "invalid_input"
	| "invalid_output"
	| "not_found"
	| "timeout"
	| "handler_error";

export type CapabilityResult =
	| { ok: true; output: JsonValue }
	| { ok: false; error: { code: CapabilityErrorCode; message: string; retryable?: boolean } };

/** A builtin handler. It receives parsed JSON and the JSON context, never `env`, a database handle or a function. */
export type CapabilityHandler = (input: JsonValue, ctx: CapabilityCallContext) => Promise<JsonValue>;
