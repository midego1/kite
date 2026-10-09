"use client";

import { useAuthMe } from "./use-auth-me";
import type { AuthMeUser } from "@/lib/auth/me-client-types";

export type CurrentUser = AuthMeUser;

export function useCurrentUser(): CurrentUser | null {
	return useAuthMe().data?.user ?? null;
}
