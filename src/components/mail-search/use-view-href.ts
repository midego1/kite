"use client";

import { useCallback } from "react";
import { hrefWithView } from "@/lib/external-accounts/account-views-utils";
import { useOptionalMailSearch } from "./mail-search-context";

/**
 * Adds the open account view (if any) to a mail link, so moving between messages of a view, leaving a message and
 * going back to the list all stay inside the view. The view lives in the address and nothing else carries it.
 */
export function useViewHref(): (href: string) => string {
	const view = useOptionalMailSearch()?.view ?? null;
	return useCallback((href: string) => hrefWithView(href, view), [view]);
}
