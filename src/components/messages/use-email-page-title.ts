"use client";

import { useEffect } from "react";
import type { EmailPageTitleInput } from "./types";
import { formatEmailPageTitle } from "./utils";

/**
 * Keeps the tab title on the folder and its counts while mounted, then puts back the title it replaced,
 * so the next page (sign-in after signing out, for one) does not keep reading "Inbox (n)".
 */
export function useEmailPageTitle({ location, total, unread, emailAddress }: EmailPageTitleInput, loading: boolean) {
	useEffect(() => {
		const previousTitle = document.title;
		return () => {
			document.title = previousTitle;
		};
	}, []);

	useEffect(() => {
		if (loading) return;
		document.title = formatEmailPageTitle({ location, total, unread, emailAddress });
	}, [location, total, unread, emailAddress, loading]);
}
