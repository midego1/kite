export type ScheduleSendOption = {
	label: string;
	value: Date | null;
};

export type ScheduleSendMenuProps = {
	disabled?: boolean;
	value: Date | null;
	onChange: (value: Date | null) => void;
	mailboxId?: string | null;
	from: string;
	onApplyTemplate: (template: { title: string; html: string }) => void;
};
