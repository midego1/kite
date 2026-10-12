export interface OneTimeCodeChipProps {
	/** The detected code; the chip renders nothing when it is null. */
	code: string | null;
	/** Mirrors the reader's subject indent, which widens when no panel is open. */
	alignWide: boolean;
}
