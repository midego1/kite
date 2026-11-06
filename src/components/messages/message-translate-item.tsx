"use client";

import { Languages } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageTranslateMenu } from "./message-translation-types";

const ITEM = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm";

/** The Translate entry of a message's More menu; with AI off for the mailbox it stays, greyed out, and says why. */
export function MessageTranslateItem({ menu, onClose }: { menu: MessageTranslateMenu; onClose: () => void }) {
	if (menu.disabledReason)
		return (
			<Tooltip label={menu.disabledReason}>
				<button
					type="button"
					aria-disabled="true"
					aria-label={`${menu.label}: ${menu.disabledReason}`}
					data-testid="translate-ai-off"
					className={`${ITEM} cursor-not-allowed text-neutral-400`}
				>
					<Languages className="h-4 w-4" />
					{menu.label}
				</button>
			</Tooltip>
		);
	return (
		<button
			type="button"
			className={`${ITEM} text-neutral-700 hover:bg-neutral-100`}
			onClick={() => {
				onClose();
				menu.onSelect();
			}}
		>
			<Languages className="h-4 w-4" />
			{menu.label}
		</button>
	);
}
