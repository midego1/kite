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
