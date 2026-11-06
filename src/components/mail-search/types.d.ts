export type MailSearchContextValue = {
	/**
	 * What lists fetch with: the open view's `via:` search (when one is open) followed by the debounced text of the
	 * search box, so typing inside a view searches within it.
	 */
	query: string;
	/** Live value of the search box; the open view's search is not in it. */
	input: string;
	setQuery: (query: string) => void;
	/**
	 * The address of the connected account whose view is open, or null. A view narrows the list to mail that came in
	 * through the account without being typed into the search box.
	 */
	view: string | null;
	/** Opens the view of an account's mail (its address), or closes the open view with null. */
	setView: (address: string | null) => void;
};
