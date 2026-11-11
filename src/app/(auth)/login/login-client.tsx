"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KeyRound, Mail, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TurnstileField } from "@/components/auth/turnstile";
import { conditionalMediationAvailable, isPasskeyCancel, passkeysSupported } from "@/lib/auth/passkey-client-utils";
import { PasskeySignInUnavailableError, signInWithPasskey, submitLogin, submitMfaCode } from "./utils";

const subscribeNever = () => () => {};

export function LoginClient({
	adding = false,
	justFinishedSetup = false,
	next,
}: {
	adding?: boolean;
	justFinishedSetup?: boolean;
	/** The MCP consent screen to return to (`loginNextPath`). */
	next?: string;
}) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [turnstileReset, setTurnstileReset] = useState(0);
	// Set once the password is accepted for an account with a second factor.
	const [challengeToken, setChallengeToken] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [passkeyLoading, setPasskeyLoading] = useState(false);
	// Read after hydration only: the server cannot know whether the browser has WebAuthn.
	const canUsePasskeys = useSyncExternalStore(subscribeNever, passkeysSupported, () => false);
	// The pending passkey request, autofill or dialog; the browser allows only one at a time.
	const passkeyRequest = useRef<AbortController | null>(null);

	const finish = useCallback(
		(redirect?: string) => {
			router.replace(justFinishedSetup ? "/admin" : (next ?? redirect ?? "/inbox"));
			router.refresh();
		},
		[router, justFinishedSetup, next],
	);

	/** Offers the browser's passkeys in the email field's autofill until one is picked or the page changes. */
	const offerPasskeyAutofill = useCallback(() => {
		passkeyRequest.current?.abort();
		const controller = new AbortController();
		passkeyRequest.current = controller;
		void (async () => {
			if (!(await conditionalMediationAvailable())) return;
			// A refused passkey used its challenge up, so the autofill is offered again with a fresh one.
			while (!controller.signal.aborted) {
				try {
					const result = await signInWithPasskey({ conditional: true, signal: controller.signal });
					if (!result || controller.signal.aborted) return;
					if (result.ok) {
						finish(result.data.redirect);
						return;
					}
					setError(result.data.error ?? "Passkey sign-in failed");
				} catch (error) {
					if (controller.signal.aborted || isPasskeyCancel(error)) return;
					if (!(error instanceof PasskeySignInUnavailableError))
						setError(error instanceof Error ? error.message : "Passkey sign-in failed");
					return;
				}
			}
		})();
	}, [finish]);

	useEffect(() => {
		if (challengeToken) return;
		offerPasskeyAutofill();
		return () => passkeyRequest.current?.abort();
	}, [challengeToken, offerPasskeyAutofill]);

	async function onPasskeySignIn() {
		passkeyRequest.current?.abort();
		const controller = new AbortController();
		passkeyRequest.current = controller;
		setPasskeyLoading(true);
		setError(null);
		try {
			const result = await signInWithPasskey({ conditional: false, signal: controller.signal });
			if (result?.ok) {
				finish(result.data.redirect);
				return;
			}
			if (result) setError(result.data.error ?? "Passkey sign-in failed");
		} catch (error) {
			if (!isPasskeyCancel(error)) setError(error instanceof Error ? error.message : "Passkey sign-in failed");
		} finally {
			setPasskeyLoading(false);
		}
		if (passkeyRequest.current === controller) offerPasskeyAutofill();
	}

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setLoading(true);
		setError(null);

		try {
			const { ok, data } = await submitLogin(new FormData(e.currentTarget));
			if (!ok) {
				setError(data.error ?? "Login failed");
				setTurnstileReset((value) => value + 1);
				return;
			}
			if (data.mfaRequired && data.challengeToken) {
				setChallengeToken(data.challengeToken);
				return;
			}
			finish(data.redirect);
		} catch (error) {
			setError(
				error instanceof DOMException && error.name === "TimeoutError"
					? "Login timed out. Please try again."
					: "Unable to reach the login service. Please try again.",
			);
			setTurnstileReset((value) => value + 1);
		} finally {
			setLoading(false);
		}
	}

	async function onSubmitCode(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!challengeToken) return;
		setLoading(true);
		setError(null);
		try {
			const { ok, data } = await submitMfaCode(challengeToken, code);
			if (!ok) {
				setError(data.error ?? "That code did not match");
				// An expired challenge sends the user back to the password step.
				if (data.error?.includes("expired")) {
					setChallengeToken(null);
					setCode("");
				}
				return;
			}
			finish(data.redirect);
		} catch {
			setError("Unable to reach the login service. Please try again.");
		} finally {
			setLoading(false);
		}
	}

	if (challengeToken) {
		return (
			<AuthShell
				icon={ShieldCheck}
				title="Two-factor authentication"
				description="Enter the 6-digit code from your authenticator app, or one of your recovery codes."
			>
				<form key="code" onSubmit={onSubmitCode} className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="code">Code</Label>
						<Input
							id="code"
							name="code"
							value={code}
							onChange={(event) => setCode(event.target.value)}
							inputMode="numeric"
							autoComplete="one-time-code"
							autoFocus
							placeholder="123 456"
							required
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "login-error" : undefined}
						/>
					</div>
					{error && (
						<p
							id="login-error"
							role="alert"
							className="rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999] px-4 py-3 text-sm font-medium"
						>
							{error}
						</p>
					)}
					<Button type="submit" className="h-10 w-full [@media(pointer:coarse)]:h-11" disabled={loading}>
						{loading ? "Verifying..." : "Verify"}
					</Button>
					<button
						type="button"
						className="w-full rounded-md text-center text-sm text-neutral-500 outline-hidden hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500 [@media(pointer:coarse)]:min-h-11"
						onClick={() => {
							setChallengeToken(null);
							setCode("");
							setError(null);
						}}
					>
						Back to sign in
					</button>
				</form>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			icon={Mail}
			title={adding ? "Add another account" : "Sign in"}
			description={
				adding
					? "Sign in to another account. You can switch between accounts from the account menu."
					: "Open your mailbox and continue from the same inbox workspace."
			}
		>
			<form key="password" method="post" onSubmit={onSubmit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						name="email"
						type="email"
						autoComplete="username webauthn"
						required
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "login-error" : undefined}
					/>
				</div>
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<Label htmlFor="password">Password</Label>
						<Link
							href="/forgot-password"
							className="inline-flex items-center text-xs font-medium text-blue-600 hover:underline [@media(pointer:coarse)]:min-h-11"
						>
							Forgot password?
						</Link>
					</div>
					<Input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						required
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "login-error" : undefined}
					/>
				</div>
				{error && (
					<p
						id="login-error"
						role="alert"
						className="rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999] px-4 py-3 text-sm font-medium"
					>
						{error}
					</p>
				)}
				<TurnstileField resetSignal={turnstileReset} />
				<Button type="submit" className="h-10 w-full [@media(pointer:coarse)]:h-11" disabled={loading}>
					{loading ? "Signing in..." : "Sign in"}
				</Button>
				{canUsePasskeys && (
					<Button
						type="button"
						variant="outline"
						className="h-10 w-full [@media(pointer:coarse)]:h-11"
						disabled={loading || passkeyLoading}
						onClick={() => void onPasskeySignIn()}
					>
						<KeyRound className="h-4 w-4" />
						{passkeyLoading ? "Waiting for your passkey..." : "Sign in with a passkey"}
					</Button>
				)}
			</form>
		</AuthShell>
	);
}
