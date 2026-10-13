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

/** What a module's lazy client chunk exports. */
export type ModuleClient = {
	/** Client command handlers by the `handler` name in `UiCommand.target`. */
	commandHandlers?: Record<string, CommandHandler>;
	/** Suggestion card blocks by the kind the module's `suggestion_kind` capability declares. */
	suggestionCards?: Record<string, ModuleSuggestionCard>;
	/** Composer slots by the `id` the manifest declares. */
	composerSlots?: Record<string, ModuleComposerSlot>;
};
