"use client";

import Link from "next/link";
import { useState } from "react";
import { TextAlignJustify } from "lucide-react";
import { useBranding } from "./branding-provider";
import { useSidebar } from "./sidebar-state";
import type { SidebarHeaderProps } from "./sidebar-state-types";
import { Tooltip } from "./ui/tooltip";

export function SidebarHeader({ href, label }: SidebarHeaderProps) {
	const branding = useBranding();
	const { minimal, toggle } = useSidebar();
	// Bumped on every toggle so the logo remounts and replays its flight.
	const [flight, setFlight] = useState(0);
	const logoClassName = flight > 0 ? "kite-fly-away" : undefined;
	const logo = <img key={flight} src={branding.iconUrl} height={32} width={32} alt="" className={logoClassName} />;

	const toggleButton = (
		<button
			type="button"
			onClick={() => {
				toggle();
				setFlight((value) => value + 1);
			}}
			className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
			aria-label={minimal ? "Expand menu" : "Collapse menu"}
		>
			{minimal ? logo : <TextAlignJustify size={18} />}
		</button>
	);
	return (
		<div className={`mb-3 flex h-10 items-center ${minimal ? "" : "gap-2 px-1"}`}>
			{minimal ? (
				<Tooltip label="Expand menu" placement="right">
					{toggleButton}
				</Tooltip>
			) : (
				toggleButton
			)}
			{!minimal && (
				<Link href={href} className="flex min-w-0 items-center gap-3">
					{logo}
					<span className="truncate text-xl font-bold tracking-tight text-neutral-900">
						{label ?? branding.appName}
					</span>
				</Link>
			)}
		</div>
	);
}
