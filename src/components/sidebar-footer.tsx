"use client";

import { BUILD_VERSION_LABEL } from "@/lib/build-version";
import { useSidebar } from "./sidebar-state";
import { useShortcuts } from "./shortcuts";
import { Keyboard, Palette } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { useStylePreference } from "./use-style-preference";

function StyleToggle() {
	const [style, saveStyle] = useStylePreference();
	const kite = style === "kite";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={kite}
			onClick={() => saveStyle(kite ? "classic" : "kite")}
			className="flex items-center justify-between w-full px-2.5 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200/60 rounded-lg transition-colors"
		>
			<span className="flex items-center gap-1.5">
				<Palette className="w-3.5 h-3.5 text-neutral-400" />
				Kite design
			</span>
			<span
				aria-hidden
				className={`relative h-4 w-7 rounded-full transition-colors ${kite ? "bg-blue-600" : "bg-neutral-300"}`}
			>
				<span
					className={`absolute top-0.5 h-3 w-3 rounded-full bg-[#fff] shadow-sm transition-[left] ${kite ? "left-3.5" : "left-0.5"}`}
				/>
			</span>
		</button>
	);
}

export function SidebarFooter() {
	const { minimal } = useSidebar();
	const { openHelpModal, shortcutsEnabled, shortcutsPreferenceLoading } = useShortcuts();
	if (minimal) return null;

	return (
		<div className="px-3 pt-3 flex flex-col gap-2">
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
			<p className="px-1 text-[11px] text-neutral-400">
				Kite v{BUILD_VERSION_LABEL} ·{" "}
				<a href={SOURCE_CODE_URL} target="_blank" className="hover:underline text-neutral-500" rel="noreferrer">
					Source code
				</a>
			</p>
		</div>
	);
}
