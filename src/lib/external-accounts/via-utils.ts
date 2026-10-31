import { EXTERNAL_ACCOUNT_PRESETS, findPreset } from "./presets-utils";
import type { ExternalAccountPresetId } from "./types";

/**
 * The connected account a message came in by (or a sent copy went out through), as list rows and the reader get it
 * (`messages.external_account_id`, spec §18 decision 1). Null once the account is removed.
 */
export type MessageVia = {
	accountId: string;
	label: string;
	address: string;
	preset: ExternalAccountPresetId;
};

/** The provider part of a chip: the preset's short name, or the address's domain for an "Other" account. */
function providerName(via: Pick<MessageVia, "address" | "preset">): string {
	if (via.preset === "other") return via.address.split("@").pop() || via.address;
	return findPreset(via.preset)?.label ?? via.address;
}

/**
 * The chip's text, without "via": the label the user gave the account, or its provider while the label is still the
 * address it starts as (so two Gmail accounts can be told apart by renaming one).
 */
export function viaChipText(via: Pick<MessageVia, "label" | "address" | "preset">): string {
	const label = via.label.trim();
	if (label && label.toLowerCase() !== via.address.toLowerCase()) return label;
	return providerName(via);
}

/** The chip's tooltip: which address the message came through, or went out through. */
export function viaChipTitle(via: Pick<MessageVia, "address">, direction: "inbound" | "outbound"): string {
	return direction === "outbound" ? `Sent through ${via.address}` : `Arrived through ${via.address}`;
}

/** The search that lists everything that came through the same account (`via:` takes the exact address). */
export function viaSearchQuery(via: Pick<MessageVia, "address">): string {
	return `via:${via.address}`;
}

/** Everyday names for the providers, besides each preset's id and label. */
const PROVIDER_ALIASES: Record<string, ExternalAccountPresetId[]> = {
	google: ["gmail", "google_workspace"],
	googlemail: ["gmail"],
	workspace: ["google_workspace"],
	outlook: ["microsoft"],
	hotmail: ["microsoft"],
	office365: ["microsoft"],
	m365: ["microsoft"],
	apple: ["icloud"],
	yahoo: ["yahoo"],
	aol: ["aol"],
	imap: ["other"],
};

const searchable = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * What a `via:` value matches (the search grammar in `src/lib/search/query-utils.ts`): a provider (`via:gmail`,
 * `via:icloud`, `via:outlook`), an account's whole address (`via:me@gmail.com`) or label (`via:"Work Gmail"`, case
 * folded), or the domain of its address (`via:example.com`). SQLite's lower() folds only A-Z, so the value is folded
 * the same way.
 */
export function viaSearchFilter(raw: string): {
	value: string;
	presets: ExternalAccountPresetId[];
	domain: string | null;
} {
	const value = raw.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	const key = searchable(value);
	const presets = new Set<ExternalAccountPresetId>(PROVIDER_ALIASES[key] ?? []);
	for (const preset of EXTERNAL_ACCOUNT_PRESETS)
		if (searchable(preset.id) === key || searchable(preset.label) === key) presets.add(preset.id);
	const domain = !value.includes("@") && value.includes(".") ? value : null;
	return { value, presets: [...presets], domain };
}
