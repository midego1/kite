import type { ComponentType } from "react";
import type { ModuleSuggestionCard } from "@/components/agent/suggestion-card-types";
import type { CommandHandler } from "@/lib/modules/module-types";

/** What the composer gives a slot: where the draft is from, and how to put content into it. */
export type ComposerSlotContext = {
	mailboxId?: string | null;
	from: string;
	/** Sets the subject when it is empty and appends the body to what is already written. */
	applyContent: (content: { subject: string; html: string }) => void;
};

/** One composer slot: a menu entry inside the send menu, and optionally UI that outlives the menu. */
export type ModuleComposerSlot = {
	MenuItem: ComponentType<ComposerSlotContext & { openOverlay: () => void }>;
	Overlay?: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void } & ComposerSlotContext>;
};

/** All a message menu slot learns about the message it was opened on. */
export type MessageSlotContext = { messageId: string; mailboxId: string | null };

/** One message menu slot: core draws the menu entry from the manifest label and opens this when it is chosen. */
export type ModuleMessageSlot = {
	Overlay: ComponentType<MessageSlotContext & { open: boolean; onOpenChange: (open: boolean) => void }>;
};

/** All an attachment menu slot learns about the attachment it was opened on. */
export type AttachmentSlotContext = {
	messageId: string;
	mailboxId: string | null;
	attachmentId: string;
};

/** One attachment menu slot: core draws the menu entry from the manifest label and opens this when it is chosen. */
export type ModuleAttachmentSlot = {
	Overlay: ComponentType<AttachmentSlotContext & { open: boolean; onOpenChange: (open: boolean) => void }>;
};

/** All a reading pane card learns about where it is shown: the mailbox selected, null for all mailboxes. */
export type ReadingPaneSlotContext = { mailboxId: string | null };

/**
 * One reading pane card. The module draws the whole card (with `CommandCenterCard` for the shared look),
 * fetches its own data through its own API and renders nothing while that is loading, failing or not there.
 */
export type ModuleReadingPaneSlot = {
	Card: ComponentType<ReadingPaneSlotContext>;
};

/** What a module's reading pane chunk exports: kept apart from the client chunk so the pane loads only its cards. */
export type ModulePaneClient = {
	/** Reading pane cards by the `id` the manifest declares. */
	readingPaneSlots?: Record<string, ModuleReadingPaneSlot>;
};

/** What a module's lazy client chunk exports. */
export type ModuleClient = {
	/** Client command handlers by the `handler` name in `UiCommand.target`. */
	commandHandlers?: Record<string, CommandHandler>;
	/** Suggestion card blocks by the kind the module's `suggestion_kind` capability declares. */
	suggestionCards?: Record<string, ModuleSuggestionCard>;
	/** Composer slots by the `id` the manifest declares. */
	composerSlots?: Record<string, ModuleComposerSlot>;
	/** Message menu slots by the `id` the manifest declares. */
	messageSlots?: Record<string, ModuleMessageSlot>;
	/** Attachment menu slots by the `id` the manifest declares. */
	attachmentSlots?: Record<string, ModuleAttachmentSlot>;
};
