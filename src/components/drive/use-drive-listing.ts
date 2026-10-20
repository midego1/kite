"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { DriveCategory } from "@/lib/drive/category-names-utils";
import { driveError } from "./drive-api";
import type { DriveListing, DriveListingView } from "./drive-types";
import { DRIVE_REFRESH_EVENT, DRIVE_USAGE_EVENT } from "./drive-utils";

export type DriveListingQuery = {
	view: DriveListingView;
	folderId: string | null;
	query: string;
	types: DriveCategory[];
};

function listingUrl(query: DriveListingQuery, cursor: string | null): string {
	const search = new URLSearchParams();
	if (query.view !== "attachments") search.set("view", query.folderId ? "my" : query.view);
	if (query.folderId) search.set("parent", query.folderId);
	if (query.query) search.set("q", query.query);
	if (query.types.length) search.set("types", query.types.join(","));
	if (cursor) search.set("cursor", cursor);
	const base = query.view === "attachments" && !query.folderId ? "/api/drive/attachments" : "/api/drive/items";
	return `${base}?${search}`;
}

type State = { key: string; listing: DriveListing | null; error: string | null; notFound: boolean };

/**
 * One listing and its further pages. A response for a listing the page has already left is dropped, and
 * a refresh (after any change, or the refresh event) reloads the first page.
 */
export function useDriveListing(query: DriveListingQuery) {
	const key = listingUrl(query, null);
	const [state, setState] = useState<State>({ key: "", listing: null, error: null, notFound: false });
	const [loadingMore, setLoadingMore] = useState(false);
	const current = useRef(key);
	useEffect(() => {
		current.current = key;
	}, [key]);

	const load = useCallback(async () => {
		try {
			const response = await authFetch(key);
			if (response.status === 404) {
				if (current.current === key) setState({ key, listing: null, error: null, notFound: true });
				return;
			}
			if (!response.ok) throw new Error(await driveError(response, "Could not load your files"));
			const listing = (await response.json()) as DriveListing;
			if (current.current !== key) return;
			setState({
				key,
				listing: { ...listing, path: listing.path ?? [], role: listing.role ?? "owner" },
				error: null,
				notFound: false,
			});
			if (listing.usage) window.dispatchEvent(new CustomEvent(DRIVE_USAGE_EVENT, { detail: listing.usage }));
		} catch (error) {
			if (current.current === key)
				setState({
					key,
					listing: null,
					error: error instanceof Error ? error.message : "Could not load",
					notFound: false,
				});
		}
	}, [key]);

	useEffect(() => {
		// load() only sets state after the fetch resolves, never synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
		const onRefresh = () => void load();
		window.addEventListener(DRIVE_REFRESH_EVENT, onRefresh);
		return () => window.removeEventListener(DRIVE_REFRESH_EVENT, onRefresh);
	}, [load]);

	const listing = state.key === key ? state.listing : null;

	const loadMore = useCallback(async () => {
		const cursor = listing?.nextCursor;
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		try {
			const response = await authFetch(listingUrl(query, cursor));
			if (!response.ok) return;
			const next = (await response.json()) as DriveListing;
			setState((previous) =>
				previous.key === key && previous.listing
					? {
							...previous,
							listing: {
								...previous.listing,
								items: [...previous.listing.items, ...next.items],
								nextCursor: next.nextCursor,
							},
						}
					: previous,
			);
		} finally {
			setLoadingMore(false);
		}
	}, [key, listing?.nextCursor, loadingMore, query]);

	return {
		listing,
		loading: state.key !== key,
		error: state.key === key ? state.error : null,
		notFound: state.key === key && state.notFound,
		reload: load,
		loadMore,
		loadingMore,
	};
}
