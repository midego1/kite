"use client";

import { useRouter } from "next/navigation";
import { useViewHref } from "@/components/mail-search/use-view-href";
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, PanelTopClose, PanelTopOpen } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessageListVisibility } from "./message-list-visibility";
import { useT } from "@/lib/i18n/use-t";

export function MessageReadingHeaderButton() {
	const t = useT();
	const router = useRouter();
	const viewHref = useViewHref();
	const { visible, toggle, singleColumn, stacked, backHref, backLabel } = useMessageListVisibility();
	const label = singleColumn
		? t("Back to {backLabel}", { backLabel })
		: visible
			? t("Hide email list")
			: t("Show email list");
	const PanelIcon = stacked ? (visible ? PanelTopClose : PanelTopOpen) : visible ? PanelLeftClose : PanelLeftOpen;

	function handleClick() {
		if (singleColumn) router.push(viewHref(backHref));
		else toggle();
	}

	return (
		<Tooltip label={label} className="inline-flex">
			<button
				type="button"
				className="relative z-10 shrink-0 rounded-full p-2 text-neutral-600 duration-200 hover:bg-neutral-100 hover:text-neutral-900"
				onClick={handleClick}
				aria-label={label}
				aria-pressed={singleColumn ? undefined : visible}
			>
				{singleColumn ? <ArrowLeft size={18} className="rtl:-scale-x-100" /> : <PanelIcon size={18} />}
			</button>
		</Tooltip>
	);
}
