"use client";

import { useEffect, useState } from "react";
import { BUILD_TIME, BUILD_VERSION_LABEL } from "@/lib/build-version";
import { formatBuildTime } from "@/lib/build-version-utils";
import { ChangelogDialog } from "./changelog-dialog";
import { useSidebar } from "./sidebar-state";
import { useShortcuts } from "./shortcuts";
import Link from "next/link";
import type { ReactNode } from "react";
import { Keyboard, LifeBuoy, Palette, Settings, type LucideIcon } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { useStylePreference } from "./use-style-preference";

function StyleToggle() {
	const [style, saveStyle] = useStylePreference();
	const lavender = style === "lavender";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={lavender}
			onClick={() => saveStyle(lavender ? "kite" : "lavender")}
			className="flex items-center justify-between w-full px-2.5 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200/60 rounded-lg transition-colors"
		>
			<span className="flex items-center gap-1.5">
				<Palette className="w-3.5 h-3.5 text-neutral-400" />
				Kite classic
			</span>
			<span
				aria-hidden
				className={`relative h-4 w-7 rounded-full transition-colors ${lavender ? "bg-blue-600" : "bg-neutral-300"}`}
			>
				<span
					className={`absolute top-0.5 h-3 w-3 rounded-full bg-[#fff] shadow-sm transition-[left] ${lavender ? "left-3.5" : "left-0.5"}`}
				/>
			</span>
		</button>
	);
}

function FooterLink({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
	const external = href.startsWith("http");
	const className =
		"flex h-9 items-center gap-3 rounded-lg px-3 text-sm text-neutral-700 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900 max-md:min-h-11 max-md:text-base";
	const content = (
		<>
			<Icon size={16} />
			{label}
		</>
	);
	return external ? (
		<a href={href} target="_blank" rel="noreferrer" className={className}>
			{content}
		</a>
	) : (
		<Link href={href} className={className}>
			{content}
		</Link>
	);
}

/** Settings and Support pinned under the menu, as in Zero, then the style switch, shortcuts and version. */
export function SidebarFooter({ extra }: { extra?: ReactNode }) {
	const { minimal } = useSidebar();
	const { openHelpModal, shortcutsEnabled, shortcutsPreferenceLoading } = useShortcuts();
	const [changelogOpen, setChangelogOpen] = useState(false);
	const [updatedLabel, setUpdatedLabel] = useState<string | null>(null);

	useEffect(() => {
		// The label follows the browser's locale and time zone, so it cannot be part of the server render.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setUpdatedLabel(formatBuildTime(BUILD_TIME));
	}, []);

	if (minimal) return null;

	return (
		<div className="flex flex-col gap-px pt-2">
			<FooterLink href="/settings/account" icon={Settings} label="Settings" />
			<FooterLink href={`${SOURCE_CODE_URL}/issues`} icon={LifeBuoy} label="Support" />
			{extra}
			<div className="mt-2 flex flex-col gap-1">
				<StyleToggle />
				{shortcutsEnabled && !shortcutsPreferenceLoading && (
					<button
						type="button"
						onClick={openHelpModal}
						className="flex items-center justify-between w-full px-2.5 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200/60 rounded-lg transition-colors"
					>
						<span className="flex items-center gap-1.5">
							<Keyboard className="w-3.5 h-3.5 text-neutral-400" />
							Shortcuts
						</span>
						<kbd className="px-1.5 py-0.5 font-mono text-[10px] bg-white border border-neutral-200 rounded text-neutral-500 shadow-2xs">
							?
						</kbd>
					</button>
				)}
				<p className="px-1 text-[11px] text-neutral-500">
					<button
						type="button"
						onClick={() => setChangelogOpen(true)}
						title="What's new in Kite"
						className="rounded text-left text-neutral-500 underline-offset-2 hover:underline hover:text-neutral-700"
					>
						Updated {updatedLabel ?? "…"}
					</button>
					{" · Kite v"}
					{BUILD_VERSION_LABEL}
					{" · "}
					<a href={SOURCE_CODE_URL} target="_blank" className="hover:underline text-neutral-500" rel="noreferrer">
						Source code
					</a>
				</p>
			</div>
			<ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} updatedLabel={updatedLabel} />
		</div>
	);
}
