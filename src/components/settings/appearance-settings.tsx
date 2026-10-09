"use client";

import { useSyncExternalStore } from "react";
import { Select } from "@/components/ui/select";
import {
	isStylePreference,
	isThemePreference,
	readThemePreference,
	saveThemePreference,
	THEME_CHANGED_EVENT,
	type StylePreference,
	type ThemePreference,
} from "@/components/theme-utils";
import { useStylePreference } from "@/components/use-style-preference";
import {
	ASSISTANT_DETAIL_PREFERENCE,
	ASSISTANT_LAYOUT_PREFERENCE,
	ASSISTANT_STEPS_PREFERENCE,
	FONT_PREFERENCE,
	TEXT_SIZE_PREFERENCE,
	type AppearancePreference,
} from "@/components/appearance-preferences";
import { useAppearancePreference } from "@/components/use-appearance-preference";

const OPTIONS: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "Match system" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

// The last saved choice, so the picker still reflects it when localStorage is unavailable.
let sessionPreference: ThemePreference | null = null;

function subscribeToTheme(onChange: () => void) {
	const sync = (event: Event) => {
		const detail = (event as CustomEvent<unknown>).detail;
		if (isThemePreference(detail)) sessionPreference = detail;
		onChange();
	};
	window.addEventListener(THEME_CHANGED_EVENT, sync);
	return () => window.removeEventListener(THEME_CHANGED_EVENT, sync);
}

function getThemeSnapshot(): ThemePreference {
	return sessionPreference ?? readThemePreference();
}

const STYLE_OPTIONS: { value: StylePreference; label: string }[] = [
	{ value: "kite", label: "Kite" },
	{ value: "classic", label: "Classic" },
];

export function AppearanceSettings() {
	return (
		<div className="space-y-3">
			<ThemeSetting />
			<StyleSetting />
			<PreferenceRow
				preference={FONT_PREFERENCE}
				label="Font"
				description="The typeface for the whole app. Match style uses Manrope in Kite and Geist in Classic."
			/>
			<PreferenceRow
				preference={TEXT_SIZE_PREFERENCE}
				label="Text size"
				description="Scales text and spacing across the app."
			/>
			<PreferenceRow
				preference={ASSISTANT_LAYOUT_PREFERENCE}
				label="Assistant"
				description="Open the assistant as a resizable side panel, or as a floating chat window like a new message."
			/>
			<AssistantOutputSettings />
			<p className="rounded-xl border border-neutral-200 p-4 text-sm text-neutral-700">
				<span className="block font-semibold text-neutral-900">Preview: A fresh direction for Kite</span>
				The updated brand files are ready. We kept things light, clear, and connected.
				<span className="mt-1 block font-script text-2xl text-blue-600">that actually flows.</span>
			</p>
		</div>
	);
}

export function AssistantOutputSettings({ compact = false }: { compact?: boolean }) {
	return (
		<>
			<PreferenceRow
				compact={compact}
				preference={ASSISTANT_STEPS_PREFERENCE}
				label="Assistant steps"
				description="Whether the steps the assistant takes (searches, counts, reads) appear while it works, stay folded, or are left out."
			/>
			<PreferenceRow
				compact={compact}
				preference={ASSISTANT_DETAIL_PREFERENCE}
				label="Step details"
				description="How much each step shows when opened: just its name, the emails it found, or everything including search parameters and email text."
			/>
			{compact && (
				<details className="text-xs text-neutral-500">
					<summary className="cursor-pointer py-1">Display help</summary>
					<p className="mt-1">
						Steps can appear live, stay collapsed, or be hidden. Details control whether opened steps show names,
						emails, or all technical fields. Saved in this browser.
					</p>
				</details>
			)}
		</>
	);
}

function PreferenceRow<T extends string>({
	preference,
	label,
	description,
	compact = false,
}: {
	preference: AppearancePreference<T>;
	label: string;
	description: string;
	compact?: boolean;
}) {
	const [value, save] = useAppearancePreference(preference);
	return (
		<label
			className={
				compact
					? "flex flex-wrap items-center justify-between gap-2 py-1"
					: "flex items-start gap-3 rounded-xl bg-neutral-50 p-4"
			}
		>
			<span className="flex-1">
				<span className="block text-sm font-medium text-neutral-900">{label}</span>
				<span className={compact ? "sr-only" : "mt-1 block text-sm text-neutral-500"}>
					{description} Saved in this browser.
				</span>
			</span>
			<Select
				value={value}
				aria-label={label}
				className="py-1.5 text-sm text-neutral-900"
				onChange={(event) => {
					const next = preference.options.find((option) => option.value === event.target.value);
					if (next) save(next.value);
				}}
			>
				{preference.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		</label>
	);
}

function StyleSetting() {
	const [style, saveStylePreference] = useStylePreference();

	return (
		<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
			<span className="flex-1">
				<span className="block text-sm font-medium text-neutral-900">Style</span>
				<span className="mt-1 block text-sm text-neutral-500">
					Kite uses indigo and lavender with script accents. Classic uses the original blue. Saved in this browser.
				</span>
			</span>
			<Select
				value={style}
				aria-label="Style"
				className="py-1.5 text-sm text-neutral-900"
				onChange={(event) => {
					const next = event.target.value;
					if (!isStylePreference(next)) return;
					saveStylePreference(next);
				}}
			>
				{STYLE_OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		</label>
	);
}

function ThemeSetting() {
	const preference = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => "system" as const);

	return (
		<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
			<span className="flex-1">
				<span className="block text-sm font-medium text-neutral-900">Theme</span>
				<span className="mt-1 block text-sm text-neutral-500">
					Use a light or dark interface, or follow your system setting. Saved in this browser.
				</span>
			</span>
			<Select
				value={preference}
				aria-label="Theme"
				className="py-1.5 text-sm text-neutral-900"
				onChange={(event) => {
					const next = event.target.value;
					if (!isThemePreference(next)) return;
					saveThemePreference(next);
				}}
			>
				{OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		</label>
	);
}
