import type { UnavailableModels } from "./model-fallback-utils";
export type AgentEvent =
	| { type: "conversation"; conversationId: string }
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "reclassify"; text: string }
	| {
			type: "tool";
			id: string;
			name: string;
			state: "running" | "complete" | "failed";
			result?: unknown;
			recordId?: string;
	  }
	| { type: "error"; message: string; code?: string; details?: unknown }
	| { type: "done" };

export type AgentMessage = {
	id: string;
	role: "user" | "assistant" | "system" | "tool" | "reasoning";
	content: string;
	toolName?: string | null;
	toolState?: "running" | "used" | "failed";
	recordId?: string;
	createdAt?: string;
	durationMs?: number;
	pending?: boolean;
};
export type AgentEmailReference = {
	id: string;
	subject?: string | null;
	status?: string;
	from?: string;
	snippet?: string;
	url?: string;
};
export type AgentEmailLinkProps = { email: AgentEmailReference; className: string };
export type AgentActionName =
	| "move_email"
	| "move_emails"
	| "mark_email_read"
	| "mark_emails_read"
	| "mark_emails_unread"
	| "create_folder"
	| "move_emails_to_folder"
	| "discard_draft";
export type AgentActionProposal = {
	action: AgentActionName;
	status: "pending_approval" | "processing" | "approved" | "undone";
	emailId?: string;
	emailIds?: string[];
	destination?: string;
	read?: boolean;
	draftId?: string;
	expectedRevision?: number;
	emails?: AgentEmailReference[];
	/** `create_folder`: the folder's name and colour name. */
	name?: string;
	color?: string;
	/** `move_emails_to_folder`: the target folder. */
	folderId?: string;
	folderName?: string;
	/** Set once approved, for an action that can be undone. */
	actionId?: string;
	undoUntil?: string | null;
	/** Set once undone: how many of the changed emails went back. */
	undo?: { restored: number; total: number };
};
export type AgentTurn = {
	id: string;
	user: AgentMessage | null;
	assistant: AgentMessage | null;
	activity: AgentMessage[];
	durationMs: number | null;
	running: boolean;
};
export type AgentDraftAction = { messageId: string; draftId: string; revision: number; scheduledAt: string | null };
export type AgentTurnProps = {
	turn: AgentTurn;
	draftActions: AgentDraftAction[];
	onOpenDraft: (draftId: string) => void;
	onApproveDraft: (draftId: string, revision: number) => void;
	onApproveAction: (item: AgentMessage) => void;
	approvingId: string | null;
};

export type AgentSettings = {
	mailboxId: string;
	enabled: boolean;
	modelId: string | null;
	autoDraftEnabled: boolean;
	reviewerUserId: string | null;
	instructions: string;
	chatInstructions: string;
	draftInstructions: string;
	summaryInstructions: string;
	dailyLimit: number;
};

export type AgentPanelProps = {
	open: boolean;
	fullSize: boolean;
	/** Beside the page as a panel, not in a floating window. */
	docked?: boolean;
	onClose: () => void;
	onToggleFullSize: () => void;
};
export type QueuedAgentMessage = { id: string; text: string };
export type QueuedAgentMessagesProps = {
	messages: QueuedAgentMessage[];
	running: boolean;
	onRemove: (id: string) => void;
	onEdit: (id: string, text: string) => void;
	onSteer: (id: string) => void;
};

export type AgentPanelView = "chat" | "settings";
export type AgentConversation = { id: string; title: string };
export type AgentJob = {
	id: string;
	kind: "draft" | "triage" | "line_summary";
	status: string;
	reason: string | null;
	draftId: string | null;
	sourceMessageId: string;
};
export type AgentProvider = { kind: string; model: string };
export type AgentSettingsResponse = {
	settings: AgentSettings;
	models: string[];
	unavailableModels?: UnavailableModels;
	canManage: boolean;
	instructionContext?: InstructionContext;
	canConfigureProvider: boolean;
	providerConfigured: boolean;
	provider: AgentProvider | null;
	autoReplyEnabled: boolean;
	reviewers: { id: string; name: string; email: string }[];
};
export type AgentConversationsResponse = { conversations: AgentConversation[] };
export type AgentJobsResponse = { jobs: AgentJob[] };
export type AgentHistoryResponse = { messages: AgentMessage[] };
export type AgentErrorResponse = { error?: string };

/** What the instruction fields need besides their values: whether they can be saved yet, and Kite's own rules. */
export type InstructionContext = {
	/** False until migration 0069 adds the task instruction columns. */
	ready: boolean;
	fixedRules: { chat: string; draft: string };
};
