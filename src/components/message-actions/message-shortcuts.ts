import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { ShortcutDefinition } from "@/components/shortcuts/types";
import type { MessageDirection } from "@/hooks/types";
import type { ReplyMode } from "./types";

type MessageShortcutInput = {
	status: string;
	direction: MessageDirection;
	runAction: (action: BulkMessageAction) => unknown;
	handleReply: (mode: ReplyMode) => unknown;
	/** Does nothing while the message's details needed to quote it are still loading. */
	forward: () => unknown;
	canReplyAll: boolean;
	back: () => void;
};

/** The reader's single-key shortcuts for one message. */
export function messageShortcuts({
	status,
	direction,
	runAction,
	handleReply,
	forward,
	canReplyAll,
	back,
}: MessageShortcutInput): ShortcutDefinition[] {
	const archive = () => {
		if (status !== "archived") void runAction("archive");
	};
	return [
		{ key: "e", label: "Archive Message", category: "Actions", action: archive },
		{ key: "y", label: "Archive Message", category: "Actions", action: archive },
		{
			key: "#",
			label: "Move to Trash",
			category: "Actions",
			action: () => {
				if (status !== "trash") void runAction("trash");
			},
		},
		{ key: "r", label: "Reply to Message", category: "Composing", action: () => void handleReply("reply") },
		{
			key: "a",
			label: "Reply All",
			category: "Composing",
			action: () => void handleReply(canReplyAll ? "replyAll" : "reply"),
		},
		{ key: "f", label: "Forward Message", category: "Composing", action: () => void forward() },
		{
			key: "!",
			label: "Report Spam",
			category: "Actions",
			action: () => {
				if (status !== "spam" && direction === "inbound") void runAction("spam");
			},
		},
		{ key: "u", label: "Back to List", category: "Navigation", action: back },
	];
}
