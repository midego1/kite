import type { MessageKey } from "@/lib/i18n/i18n-types";
export type RichTextEditorProps = {
	id: string;
	/** Editable HTML. */
	value: string;
	onChange: (html: string) => void;
	/** Quoted or forwarded HTML shown folded under the editable area. */
	quotedHtml?: string | null;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	toolbarStart?: React.ReactNode;
	toolbarEnd?: React.ReactNode;
	footerContent?: React.ReactNode;
};

export type ToolbarCommand = {
	command: string;
	label: MessageKey;
	icon: React.ComponentType<{ className?: string }>;
	value?: string;
};
