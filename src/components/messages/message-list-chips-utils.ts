/** Search terms the list's category chips add to the mail search; the server already understands them. */
const CHIP_SEARCH_TERMS = ["has:attachment", "is:starred"] as const;
export type ChipSearchTerm = (typeof CHIP_SEARCH_TERMS)[number];

function words(query: string): string[] {
	return query.split(/\s+/).filter(Boolean);
}

export function hasSearchTerm(query: string, term: ChipSearchTerm): boolean {
	return words(query).some((word) => word.toLowerCase() === term);
}

/** Adds the term to the query, or takes it out if it is there; the rest of the query is kept as typed. */
export function toggleSearchTerm(query: string, term: ChipSearchTerm): string {
	const rest = words(query).filter((word) => word.toLowerCase() !== term);
	return (hasSearchTerm(query, term) ? rest : [...rest, term]).join(" ");
}

/** The query without any chip term, which is what "Primary" (everything) returns to. */
export function withoutChipTerms(query: string): string {
	return words(query)
		.filter((word) => !(CHIP_SEARCH_TERMS as readonly string[]).includes(word.toLowerCase()))
		.join(" ");
}
