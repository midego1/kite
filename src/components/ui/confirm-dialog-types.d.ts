export type ConfirmOptions = {
	title: string;
	description?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Styles the confirm button as a destructive action. Defaults to true. */
	destructive?: boolean;
	/** When set, the confirm button stays disabled until this exact text is typed (case-insensitive). */
	typedConfirmation?: string;
};

export type PendingConfirmation = ConfirmOptions & {
	id: number;
	resolve: (confirmed: boolean) => void;
};
