/** A screenshot written under a note as `![alt](/changelog/x.webp)`. */
export interface ChangelogImage {
	alt: string;
	/** An app path under `/changelog/`, a static asset. */
	src: string;
}

export interface ChangelogSection {
	title: string;
	items: string[];
}

export interface ChangelogRelease {
	/** The release heading, e.g. `2026.10.09.1` or `Unreleased`. */
	name: string;
	date: string | null;
	sections: ChangelogSection[];
}

export type ChangelogInline =
	{ type: "text" | "strong" | "code"; text: string } | { type: "link"; text: string; href: string };
