"use client";

import { Forward, Reply } from "lucide-react";
import { useShortcuts } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageReply, type MessageReplyInput } from "./use-message-reply";
import { useT } from "@/lib/i18n/use-t";

/**
 * Zero's "Reply" and "Forward" under the open message. They replace the toolbar's icons on wider screens; phones
 * keep Reply in the toolbar, so these stay hidden there.
 */
export function MessageReplyButtons(props: MessageReplyInput) {
	const t = useT();
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
				aria-label={shortcutsEnabled ? t("Reply (r)") : t("Reply")}
				className={buttonClass}
				onClick={() => void reply("reply")}
			>
				<Reply className="h-4 w-4 rtl:-scale-x-100" />
				{t("Reply")}
			</Button>
			{canForward && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={buttonClass}
					aria-label={t("Forward")}
					onClick={() => void forward()}
				>
					<Forward className="h-4 w-4 rtl:-scale-x-100" />
					{t("Forward")}
				</Button>
			)}
		</div>
	);
}
