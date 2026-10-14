export type ModuleId = "calendar" | "booking" | "templates" | "import" | "finance";

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
	| "finance:subscription";

export type RecordRef = { kind: RecordKind; id: string };

export type ModuleNavPlacement = "mailbox-selector" | "account-menu" | "module-tabs" | "settings-nav";

export type ModuleNavItem = {
	id: string;
	label: string;
	href: string;
	/** Resolved by the client registry, so the manifest stays data. */
	icon: string;
	placement: ModuleNavPlacement;
	/** Settings navigation group for `settings-nav` items. */
	group?: string;
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

/** One key scope as the key-creation forms show it. */
export type KeyScopeText = { scope: string; label: string; description: string };

/** The part of a manifest that browser code needs: identity, navigation and commands. */
export type ClientModuleData = Pick<ModuleManifest, "id" | "name" | "nav" | "commands"> & {
	/** Composer slots the module fills, so the composer lists them without loading the module. */
	composerSlots?: ComposerSlotDeclaration[];
	/** Suggestion kinds the module's `suggestion_kind` capabilities declare, so the reader card can pick the module's client chunk without the registry. */
	suggestionKinds?: readonly string[];
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
	| "service";

export type CapabilityEffect = "none" | "read" | "create" | "update" | "delete" | "send" | "external";

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
	/** `answer` names the `service` capability that handles an accept click on this kind of suggestion. */
	suggestionKind?: { kind: string; label: string; reasonTemplate: string; answer?: string };
	/** `requires` names a fact core checks first: the step is neither run nor recorded as skipped without it. */
	triage?: { order: number; requires?: "invite_attachment" };
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
	};
	event?: { value: string };
	lifecycle?: { event: "user.created" | "user.time_zone_changed"; dataHook: boolean };
	cron?: { task: string };
	queue?: { kind: string };
	jmap?: { urn?: string; capability?: JsonValue; method?: string };
};

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
