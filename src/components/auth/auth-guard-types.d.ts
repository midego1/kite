import type { ReactNode } from "react";

export type AuthGuardMode = "protected" | "public";

export type AuthGuardProps = {
	children: ReactNode;
	mode?: AuthGuardMode;
	requireMailbox?: boolean;
	requireRole?: "admin";
	requirePrimary?: boolean;
	/** Public page that stays usable while signed in (adding another account). */
	allowAuthenticated?: boolean;
};

export type AuthGuardDecisionInput = Omit<AuthGuardProps, "children" | "mode"> & {
	mode: AuthGuardMode;
	status: "pending" | "error" | "success";
	session: import("@/lib/auth/me-client-types").AuthMeResponse | null | undefined;
	pathname: string;
};

export type AuthGuardDecision = {
	authorized: boolean;
	redirect: string | null;
};
