"use client";

import { useSyncExternalStore } from "react";
import { Select } from "@/components/ui/select";
import {
	isStylePreference,
	isThemePreference,
	DEFAULT_THEME,
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
	EMAIL_FONT_PREFERENCE,
	LIST_SUMMARIES_PREFERENCE,
	FONT_PREFERENCE,
	FONT_SCOPE_PREFERENCE,
	isDyslexiaFont,
	TEXT_SIZE_PREFERENCE,
	type AppearancePreference,
} from "@/components/appearance-preferences";
import { useAppearancePreference } from "@/components/use-appearance-preference";
import { SettingRow, SettingRows, SettingsCard, SettingsCardSection } from "@/components/ui/page";
import { isLayoutSyncEnabled } from "@/components/layout-preferences-client";
import { LAYOUT_SYNC_CHANGE_EVENT } from "@/components/layout-preferences-utils";

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
	{ value: "lavender", label: "Kite classic" },
	{ value: "classic", label: "Classic" },
];

export function AppearanceSettings() {
	return (
		<SettingsCard>
			<SettingsCardSection title="Look">
				<SettingRows>
					<ThemeSetting />
					<StyleSetting />
					<FontSettings />
					<PreferenceRow
						preference={TEXT_SIZE_PREFERENCE}
						label="Text size"
						description="Scales text and spacing across the app."
					/>
					<p className="rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-700">
						<span className="block font-semibold text-neutral-900">Preview: A fresh direction for Kite</span>
						The updated brand files are ready. We kept things light, clear, and connected.
						<span className="mt-1 block font-script text-2xl text-blue-600">that actually flows.</span>
					</p>
				</SettingRows>
			</SettingsCardSection>
			<SettingsCardSection title="Assistant" description="Where the assistant opens and how much of its work it shows.">
				<SettingRows>
					<PreferenceRow
						preference={ASSISTANT_LAYOUT_PREFERENCE}
						label="Assistant window"
						description="Open the assistant as a resizable side panel, or as a floating chat window like a new message."
					/>
					<AssistantOutputSettings />
					<PreferenceRow
						preference={LIST_SUMMARIES_PREFERENCE}
						label="Show AI summaries instead of previews"
						description="In mailboxes that write one-line summaries of new mail, the message list shows them in place of the first words of the email."
					/>
				</SettingRows>
			</SettingsCardSection>
		</SettingsCard>
	);
}

/** The Font choice and, for the dyslexia-friendly font, whether HTML mail is shown in it too. */
function FontSettings() {
	const [font] = useAppearancePreference(FONT_PREFERENCE);
	return (
		<>
			<PreferenceRow
				preference={FONT_PREFERENCE}
				label="Font"
				description="The typeface for the app and what you write. Match style uses Manrope in Kite classic and Geist otherwise. The dyslexia-friendly font (OpenDyslexic) is loaded only when chosen and gives what you read and write a little more room between letters, words and lines."
			/>
			{isDyslexiaFont(font) && (
				<>
					<PreferenceRow
						preference={FONT_SCOPE_PREFERENCE}
						label="Use it for"
						description="Text only sets emails, what you write, the message list's sender, subject and preview lines, summaries and assistant replies in the dyslexia-friendly font, and leaves menus, buttons, labels and headers as they are. Everywhere uses it for the whole app."
					/>
					<PreferenceRow
						preference={EMAIL_FONT_PREFERENCE}
						label="Font in HTML emails"
						description="Plain-text emails already use the dyslexia-friendly font. HTML emails bring their own fonts; this replaces them with the dyslexia-friendly font as well."
					/>
				</>
			)}
		</>
	);
}

/** Whether this browser shares the account's layout, which is what carries a choice with a layout key along. */
function subscribeToLayoutSync(onChange: () => void) {
	window.addEventListener(LAYOUT_SYNC_CHANGE_EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(LAYOUT_SYNC_CHANGE_EVENT, onChange);
		window.removeEventListener("storage", onChange);
	};
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
	const synced = useSyncExternalStore(subscribeToLayoutSync, isLayoutSyncEnabled, () => false);
	// Only a choice with a layout key travels with the account, and only while this browser shares the layout.
	const note =
		preference.layoutKey && synced ? `${description} Follows your account to your other devices.` : description;
	const select = (
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
	);
	if (compact) {
		return (
			<label className="flex flex-wrap items-center justify-between gap-2 py-1">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">{label}</span>
					<span className="sr-only">{note}</span>
				</span>
				{select}
			</label>
		);
	}
	return <SettingRow label={label} description={note} control={select} />;
}

function StyleSetting() {
	const [style, saveStylePreference] = useStylePreference();

	return (
		<SettingRow
			label="Style"
			description="Kite is neutral grey with one blue accent. Kite classic uses indigo and lavender with script accents. Classic uses the original blue."
			control={
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
			}
		/>
	);
}

function ThemeSetting() {
	const preference = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => DEFAULT_THEME);

	return (
		<SettingRow
			label="Theme"
			description="Use a light or dark interface, or follow your system setting."
			control={
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
			}
		/>
	);
}
