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
	 * through the account without being typed into the search box. It lives in the address (`?via=`), so it follows
	 * every navigation, Back included.
	 */
	view: string | null;
	/**
	 * Opens the view of an account's mail (its address), or closes the open view with null, by navigating (a history
	 * entry, or `replace` when the page should not be left behind).
	 */
	setView: (address: string | null, options?: { replace?: boolean }) => void;
};
