export type SendPreviewProps = {
	from: string;
	to: string;
	cc?: string;
	bcc?: string;
	subject: string;
	html: string;
	attachmentNames: string[];
	scheduledAt: Date | null;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
};
