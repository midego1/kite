"use client";

import clsx from "clsx";
import { Columns2, List, Rows2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useInterfaceDirection } from "@/components/interface-direction-provider";
import { INTERFACE_DIRECTION_OPTIONS, logicalArrowKey } from "@/components/interface-direction-utils";
import { MESSAGE_DENSITY_OPTIONS, readingPaneOptions } from "@/components/messages/reading-layout-utils";
import {
	useInterfaceDirectionPreference,
	useInterfaceLanguagePreference,
	useMessageListDensity,
	useReadingPaneMode,
} from "@/components/messages/use-reading-layout";
import { saveMessageListVisible } from "@/components/messages/message-list-visibility-utils";
import type { ReadingPaneMode } from "@/components/messages/reading-layout-types";
import { INTERFACE_LANGUAGES } from "@/lib/i18n/language-utils";
import type { LayoutInterfaceLanguage } from "@/lib/preferences/layout-types";
import { useT } from "@/lib/i18n/use-t";
import type { ReadingLayoutSegmentProps } from "./reading-layout-menu-types";

const READING_PANE_ICONS: Record<ReadingPaneMode, LucideIcon> = { none: List, right: Columns2, below: Rows2 };

/** Arrow keys move through a radio group and choose as they go; the group is one Tab stop. */
function moveWithArrows(event: KeyboardEvent<HTMLDivElement>) {
	const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[logicalArrowKey(event.key)];
	if (!step) return;
	event.preventDefault();
	const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
	const next = radios[(radios.indexOf(event.target as HTMLElement) + step + radios.length) % radios.length];
	next?.focus();
	next?.click();
}

function SegmentButton({ checked, label, description, onSelect, children }: ReadingLayoutSegmentProps) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			tabIndex={checked ? 0 : -1}
			aria-label={label}
			title={description}
			onClick={onSelect}
			className={clsx(
				"flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
				checked ? "bg-white text-blue-700 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
			)}
		>
			{children}
		</button>
	);
}

/** Quick reading-pane, density and direction switches for the account menu; changes apply at once. */
export function ReadingLayoutMenu() {
	const [readingPane, setReadingPane] = useReadingPaneMode();
	const [density, setDensity] = useMessageListDensity();
	const [directionPreference, setDirectionPreference] = useInterfaceDirectionPreference();
	const [languagePreference, setLanguagePreference] = useInterfaceLanguagePreference();
	const rtl = useInterfaceDirection() === "rtl";
	const t = useT();
	const languageOptions: { value: LayoutInterfaceLanguage; label: string; description: string }[] = [
		{
			value: "auto",
			label: t("language|Automatic"),
			description: t("Follows your browser's language where a translation is finished."),
		},
		...INTERFACE_LANGUAGES.map(({ value, label }) => ({ value, label, description: label })),
	];

	return (
		<div className="mt-3 space-y-3 border-t border-neutral-100 px-3 pt-3">
			<div>
				<p
					id="reading-pane-menu-label"
					className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500"
				>
					{t("Reading pane")}
				</p>
				<div
					role="radiogroup"
					aria-labelledby="reading-pane-menu-label"
					className="flex gap-1 rounded-xl bg-neutral-100 p-1"
					onKeyDown={moveWithArrows}
				>
					{readingPaneOptions(rtl).map((option) => {
						const Icon = READING_PANE_ICONS[option.value];
						return (
							<SegmentButton
								key={option.value}
								checked={readingPane === option.value}
								label={t(option.label)}
								description={t(option.description)}
								onSelect={() => {
									if (option.value !== "none") saveMessageListVisible(true);
									setReadingPane(option.value);
								}}
							>
								<Icon size={16} aria-hidden />
								<span className="truncate">{t(option.label)}</span>
							</SegmentButton>
						);
					})}
				</div>
			</div>
			<div>
				<p id="density-menu-label" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
					{t("Density")}
				</p>
				<div
					role="radiogroup"
					aria-labelledby="density-menu-label"
					className="flex gap-1 rounded-xl bg-neutral-100 p-1"
					onKeyDown={moveWithArrows}
				>
					{MESSAGE_DENSITY_OPTIONS.map((option) => (
						<SegmentButton
							key={option.value}
							checked={density === option.value}
							label={t(option.label)}
							description={t(option.description)}
							onSelect={() => setDensity(option.value)}
						>
							<span className="truncate">{t(option.label)}</span>
						</SegmentButton>
					))}
				</div>
			</div>
			<div>
				<p
					id="interface-direction-menu-label"
					className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500"
				>
					{t("Direction")}
				</p>
				<div
					role="radiogroup"
					aria-labelledby="interface-direction-menu-label"
					className="flex gap-1 rounded-xl bg-neutral-100 p-1"
					onKeyDown={moveWithArrows}
				>
					{INTERFACE_DIRECTION_OPTIONS.map((option) => (
						<SegmentButton
							key={option.value}
							checked={directionPreference === option.value}
							label={t(option.label)}
							description={t(option.description)}
							onSelect={() => setDirectionPreference(option.value)}
						>
							<span className="truncate">{t(option.label)}</span>
						</SegmentButton>
					))}
				</div>
			</div>
			<div>
				<p
					id="interface-language-menu-label"
					className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500"
				>
					{t("Language")}
				</p>
				<div
					role="radiogroup"
					aria-labelledby="interface-language-menu-label"
					className="grid grid-cols-2 gap-1 rounded-xl bg-neutral-100 p-1"
					onKeyDown={moveWithArrows}
				>
					{languageOptions.map((option) => (
						<SegmentButton
							key={option.value}
							checked={languagePreference === option.value}
							label={option.label}
							description={option.description}
							onSelect={() => setLanguagePreference(option.value)}
						>
							<span className="truncate" lang={option.value === "auto" ? undefined : option.value}>
								{option.label}
							</span>
						</SegmentButton>
					))}
				</div>
			</div>
		</div>
	);
}
