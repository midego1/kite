"use client";

import { Forward, Reply } from "lucide-react";
import { useShortcuts } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageReply, type MessageReplyInput } from "./use-message-reply";

/**
 * Zero's "Reply" and "Forward" under the open message. They replace the toolbar's icons on wider screens; phones
 * keep Reply in the toolbar, so these stay hidden there.
 */
export function MessageReplyButtons(props: MessageReplyInput) {
	const isMobile = useIsMobile();
	const { shortcutsEnabled } = useShortcuts();
	const { reply, forward, canForward } = useMessageReply(props);
	if (isMobile) return null;
	const buttonClass =
		"h-8 gap-1.5 rounded-lg bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200";
	return (
		<div className="mt-6 flex items-center gap-2">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={shortcutsEnabled ? "Reply (r)" : "Reply"}
				className={buttonClass}
				onClick={() => void reply("reply")}
			>
				<Reply className="h-4 w-4" />
				Reply
			</Button>
			{canForward && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={buttonClass}
					aria-label="Forward"
					onClick={() => void forward()}
				>
					<Forward className="h-4 w-4" />
					Forward
				</Button>
			)}
		</div>
	);
}
