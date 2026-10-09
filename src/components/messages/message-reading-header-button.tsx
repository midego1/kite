"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, PanelTopClose, PanelTopOpen } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessageListVisibility } from "./message-list-visibility";

export function MessageReadingHeaderButton() {
	const router = useRouter();
	const { visible, toggle, singleColumn, stacked, backHref, backLabel } = useMessageListVisibility();
	const label = singleColumn ? `Back to ${backLabel}` : visible ? "Hide email list" : "Show email list";
	const PanelIcon = stacked ? (visible ? PanelTopClose : PanelTopOpen) : visible ? PanelLeftClose : PanelLeftOpen;

	function handleClick() {
		if (singleColumn) router.push(backHref);
		else toggle();
	}

	return (
		<Tooltip label={label} className={singleColumn ? "inline-flex" : "hidden lg:inline-flex"}>
			<button
				type="button"
				className="relative z-10 shrink-0 rounded-full p-2 text-neutral-600 duration-200 hover:bg-neutral-100 hover:text-neutral-900"
				onClick={handleClick}
				aria-label={label}
				aria-pressed={singleColumn ? undefined : visible}
			>
				{singleColumn ? <ArrowLeft size={18} /> : <PanelIcon size={18} />}
			</button>
		</Tooltip>
	);
}
