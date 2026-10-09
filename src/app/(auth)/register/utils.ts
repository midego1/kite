import { clearClientSessionKey } from "@/lib/auth/client";
import { SETUP_TOKEN_HEADER } from "@/lib/auth/setup-token-utils";
import type { DomainSetupResult, MxCheckResult, RegisterResult, SetupPreparationResult, SetupStatus } from "./types";

const SETUP_TOKEN_STORAGE_KEY = "kite-setup-token";

/** Picks up `?setup_token=` from the setup link once, then keeps it for this tab only. */
export function readSetupToken(): string {
	if (typeof window === "undefined") return "";
	const url = new URL(window.location.href);
	const fromUrl = url.searchParams.get("setup_token");
	if (fromUrl) {
		sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, fromUrl);
		url.searchParams.delete("setup_token");
		window.history.replaceState(null, "", url.toString());
	}
	return sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY) ?? "";
}

export function saveSetupToken(token: string): void {
	sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, token.trim());
}

function setupHeaders(headers: Record<string, string> = {}): Record<string, string> {
	const token = readSetupToken();
	return token ? { ...headers, [SETUP_TOKEN_HEADER]: token } : headers;
}

export async function prepareSetup(): Promise<{ ok: boolean; data: SetupPreparationResult }> {
	const res = await fetch("/api/setup/prepare", { method: "POST", headers: setupHeaders() });
	return {
		ok: res.ok,
		data: (await res.json()) as SetupPreparationResult,
	};
}

export async function getSetupStatus(): Promise<SetupStatus> {
	const res = await fetch("/api/setup/status");
	const data = (await res.json()) as SetupStatus;
	if (!res.ok) throw new Error(data.error ?? "Could not load setup status");
	return data;
}

export async function submitPrimaryDomain(hostname: string): Promise<{ ok: boolean; data: DomainSetupResult }> {
	const res = await fetch("/api/setup/domain", {
		method: "POST",
		headers: setupHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify({ hostname }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as DomainSetupResult,
	};
}

export async function checkExistingMx(hostname: string): Promise<{ ok: boolean; data: MxCheckResult }> {
	const res = await fetch("/api/setup/domain/mx", {
		method: "POST",
		headers: setupHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify({ hostname }),
	});

	return {
		ok: res.ok,
		data: (await res.json()) as MxCheckResult,
	};
}

export async function submitRegistration(
	form: FormData,
	payload: { firstRun: boolean; domain: string; enableSending?: boolean; replaceMxRecords?: boolean },
): Promise<{ ok: boolean; data: RegisterResult }> {
	const res = await fetch("/api/auth/register", {
		method: "POST",
		headers: setupHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify(
			payload.firstRun
				? {
						domain: payload.domain,
						enableSending: payload.enableSending,
						replaceMxRecords: payload.replaceMxRecords,
						username: form.get("username"),
						password: form.get("password"),
						resetEmail: form.get("resetEmail"),
						turnstileToken: form.get("turnstileToken"),
					}
				: {
						username: form.get("username"),
						password: form.get("password"),
						resetEmail: form.get("resetEmail"),
						turnstileToken: form.get("turnstileToken"),
					},
		),
	});

	const data = (await res.json()) as RegisterResult;
	if (res.ok) {
		clearClientSessionKey();
		sessionStorage.removeItem(SETUP_TOKEN_STORAGE_KEY);
	}
	return { ok: res.ok, data };
}
