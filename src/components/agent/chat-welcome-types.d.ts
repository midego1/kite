import type { LucideIcon } from "lucide-react";

export type ChatWelcomeProps = {
	selectedMessageId: string | null;
	prompts: { label: string; detail: string; prompt: string; icon: LucideIcon }[];
	disabled: boolean;
	busy: boolean;
	onSubmit: (prompt: string) => void;
};
