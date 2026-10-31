/** One paragraph of a text PDF, or a horizontal rule. */
export type TextPdfBlock = {
	text?: string;
	/** Font size in points; 10.5 by default. */
	size?: number;
	bold?: boolean;
	/** 0 is black, 1 white. */
	grey?: number;
	/** Points from the left margin. */
	indent?: number;
	/** Points of space above the block, left out at the top of a page. */
	spaceBefore?: number;
	/** Draws a full-width hairline instead of text. */
	rule?: boolean;
};

export type TextPdfDocument = {
	/** The document title in the PDF's metadata; any Unicode text. */
	title: string;
	blocks: TextPdfBlock[];
};

export type TextPdfResult = {
	bytes: Uint8Array;
	pages: number;
	/** Characters the standard PDF fonts could not show as written. */
	lost: number;
};
