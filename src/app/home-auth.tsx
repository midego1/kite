"use client";

import { createContext, useContext } from "react";
import { useAuthMe } from "@/hooks/use-auth-me";
import type { MailboxSelectorUser } from "@/components/mailbox-selector-types";
import type { HomeAuthProviderProps } from "./types";

const HomeAuthContext = createContext<MailboxSelectorUser | null>(null);

export function HomeAuthProvider({ children }: HomeAuthProviderProps) {
	const user: MailboxSelectorUser | null = useAuthMe().data?.user ?? null;

	return <HomeAuthContext.Provider value={user}>{children}</HomeAuthContext.Provider>;
}

export function useHomeAuth() {
	return useContext(HomeAuthContext);
}
