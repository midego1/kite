"use client";

import { EMAIL_FONT_PREFERENCE, FONT_PREFERENCE } from "@/components/appearance-preferences";
import { fontAsset, type FontAsset } from "@/components/font-assets-utils";
import { useAppearancePreference } from "@/components/use-appearance-preference";

/**
 * The self-hosted font HTML mail is shown in, when Settings → Appearance → Font is the dyslexia-friendly font
 * and "Font in HTML emails" replaces the message's own fonts; undefined otherwise. The reader passes it to the
 * frame and asks the sanitizer to leave inline `font-family` out (`dropFontFamily`) while it is set.
 */
export function useReaderFont(): FontAsset | undefined {
	const [fontChoice] = useAppearancePreference(FONT_PREFERENCE);
	const [emailFont] = useAppearancePreference(EMAIL_FONT_PREFERENCE);
	return emailFont === "reader" ? fontAsset(fontChoice) : undefined;
}
