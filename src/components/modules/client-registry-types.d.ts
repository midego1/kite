import type { ModuleSuggestionCard } from "@/components/agent/suggestion-card-types";
import type { CommandHandler } from "@/lib/modules/module-types";

/** What a module's lazy client chunk exports. */
export type ModuleClient = {
	/** Client command handlers by the `handler` name in `UiCommand.target`. */
	commandHandlers?: Record<string, CommandHandler>;
	/** Suggestion card blocks by the kind the module's `suggestion_kind` capability declares. */
	suggestionCards?: Record<string, ModuleSuggestionCard>;
};
