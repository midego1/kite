"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
	clearMailboxesCache,
	fetchMailboxOptions,
	isIdentityMailbox,
	SELECTED_MAILBOX_STORAGE_KEY,
} from "./mailbox-provider-utils";
import { AUTH_SESSION_CHANGED_EVENT, getClientSessionKey } from "@/lib/auth/client";
import { PROFILE_NAME_CHANGED_EVENT } from "@/lib/profile/name-client";
import { PROFILE_AVATAR_CHANGED_EVENT } from "@/lib/profile/avatar-client";
import type { ProfileNameChangedDetail } from "@/lib/profile/types";
import { ALL_MAILBOXES_HIDDEN_STORAGE_KEY, ALL_MAILBOXES_STORAGE_KEY } from "@/components/appearance-preferences";
import { useStoredState } from "@/hooks/use-stored-state";
import { mailboxIdsParam, visibleMailboxIds } from "@/lib/mailboxes/scope-utils";

export type MailboxOption = {
	id: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
	signature?: string | null;
	autoReplyEnabled?: boolean;
	autoReplySubject?: string;
	autoReplyBody?: string;
	hasAvatar?: boolean;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
	senderAddresses?: string[];
	/** Null when the mailbox has no Screener settings (off). */
	screener?: { enabled: boolean; mode: "screener" | "inbox" } | null;
};

type MailboxContextValue = {
	/** The mailbox last chosen; in the All mailboxes view it stays the one Settings and Compose start from. */
	selectedMailbox: MailboxOption | null;
	/** Updates the chosen mailbox; it does not leave the All mailboxes view (use setAllMailboxes). */
	setSelectedMailbox: (mb: MailboxOption | null) => void;
	mailboxes: MailboxOption[];
	isLoading: boolean;
	/** The mail views list every mailbox (minus the filter's hidden ones); only offered with two or more. */
	allMailboxes: boolean;
	setAllMailboxes: (on: boolean) => void;
	hiddenMailboxIds: string[];
	setHiddenMailboxIds: (ids: string[]) => void;
	/** The mailboxes the mail views list right now: the selected one, or the All mailboxes view's. */
	viewMailboxes: MailboxOption[];
	/** The mailbox scope for the message hooks (`setMailboxScopeParam`). */
	mailboxScope: string | null;
};

const NO_HIDDEN_MAILBOXES: string[] = [];

const MailboxContext = createContext<MailboxContextValue | null>(null);

export function useSelectedMailbox() {
	const ctx = useContext(MailboxContext);
	if (!ctx) throw new Error("useSelectedMailbox must be used within MailboxProvider");
	return ctx;
}

export function MailboxProvider({ children }: { children: ReactNode }) {
	const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
	const [selectedMailbox, setSelectedMailboxState] = useState<MailboxOption | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [storedAllMailboxes, setAllMailboxes] = useStoredState(ALL_MAILBOXES_STORAGE_KEY, false);
	const [hiddenMailboxIds, setHiddenMailboxIds] = useStoredState(ALL_MAILBOXES_HIDDEN_STORAGE_KEY, NO_HIDDEN_MAILBOXES);
	const allMailboxes = storedAllMailboxes === true && mailboxes.length > 1;

	useEffect(() => {
		let cancelled = false;
		const sessionToken = getClientSessionKey();

		fetchMailboxOptions()
			.then((items) => {
				if (cancelled || sessionToken !== getClientSessionKey()) return;
				setMailboxes(items);

				const storedId = localStorage.getItem(SELECTED_MAILBOX_STORAGE_KEY);
				if (storedId) {
					const found = items.find((mb) => mb.id === storedId);
					if (found) {
						setSelectedMailboxState(found);
						return;
					}
				}

				const primary = items.find((mb) => mb.isPrimary) ?? items[0] ?? null;
				if (primary) {
					setSelectedMailboxState(primary);
					localStorage.setItem(SELECTED_MAILBOX_STORAGE_KEY, primary.id);
				}
			})
			.catch(() => {})
			.finally(() => {
				if (!cancelled && sessionToken === getClientSessionKey()) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		function resetMailboxState() {
			setMailboxes([]);
			setSelectedMailboxState(null);
			setIsLoading(true);
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetMailboxState);
	}, []);

	useEffect(() => {
		function updatePersonalMailboxNames(event: Event) {
			const { name } = (event as CustomEvent<ProfileNameChangedDetail>).detail;
			clearMailboxesCache();
			// Only the primary mailbox follows the profile name; the rest keep their own.
			setMailboxes((items) =>
				items.map((mailbox) => (isIdentityMailbox(mailbox) ? { ...mailbox, displayName: name } : mailbox)),
			);
			setSelectedMailboxState((mailbox) =>
				mailbox && isIdentityMailbox(mailbox) ? { ...mailbox, displayName: name } : mailbox,
			);
		}

		window.addEventListener(PROFILE_NAME_CHANGED_EVENT, updatePersonalMailboxNames);
		return () => window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, updatePersonalMailboxNames);
	}, []);

	useEffect(() => {
		function updatePersonalMailboxAvatars() {
			clearMailboxesCache();
			setMailboxes((items) =>
				items.map((mailbox) => (isIdentityMailbox(mailbox) ? { ...mailbox, hasAvatar: true } : mailbox)),
			);
			setSelectedMailboxState((mailbox) =>
				mailbox && isIdentityMailbox(mailbox) ? { ...mailbox, hasAvatar: true } : mailbox,
			);
		}

		window.addEventListener(PROFILE_AVATAR_CHANGED_EVENT, updatePersonalMailboxAvatars);
		return () => window.removeEventListener(PROFILE_AVATAR_CHANGED_EVENT, updatePersonalMailboxAvatars);
	}, []);

	const setSelectedMailbox = useCallback((mb: MailboxOption | null) => {
		setSelectedMailboxState(mb);
		if (mb) {
			setMailboxes((items) => items.map((item) => (item.id === mb.id && item !== mb ? mb : item)));
			localStorage.setItem(SELECTED_MAILBOX_STORAGE_KEY, mb.id);
		} else {
			localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
		}
	}, []);

	const view = useMemo(() => {
		if (!allMailboxes) {
			return { viewMailboxes: selectedMailbox ? [selectedMailbox] : [], mailboxScope: selectedMailbox?.id ?? null };
		}
		const ids = mailboxes.map((mailbox) => mailbox.id);
		const visible = visibleMailboxIds(ids, Array.isArray(hiddenMailboxIds) ? hiddenMailboxIds : []);
		const visibleSet = new Set(visible);
		return {
			viewMailboxes: mailboxes.filter((mailbox) => visibleSet.has(mailbox.id)),
			mailboxScope: mailboxIdsParam(ids, visible),
		};
	}, [allMailboxes, hiddenMailboxIds, mailboxes, selectedMailbox]);

	const value = useMemo(
		() => ({
			selectedMailbox,
			setSelectedMailbox,
			mailboxes,
			isLoading,
			allMailboxes,
			setAllMailboxes,
			hiddenMailboxIds,
			setHiddenMailboxIds,
			...view,
		}),
		[
			allMailboxes,
			hiddenMailboxIds,
			isLoading,
			mailboxes,
			selectedMailbox,
			setAllMailboxes,
			setHiddenMailboxIds,
			setSelectedMailbox,
			view,
		],
	);

	return <MailboxContext.Provider value={value}>{children}</MailboxContext.Provider>;
}
