"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { useBranding } from "@/components/branding-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The page frame: the install's name and icon, nothing about the owner or any account. */
export function PublicDriveFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
	const branding = useBranding();
	return (
		<div className="min-h-dvh bg-[#f6f8fc]">
			<header className="flex h-14 items-center gap-2 px-4 md:px-8">
				{/* eslint-disable-next-line @next/next/no-img-element -- the branding icon route is same-origin and tiny */}
				<img src={branding.iconUrl} alt="" width={28} height={28} className="size-7 rounded-md" />
				<span className="text-base font-semibold text-neutral-900">{branding.appName}</span>
			</header>
			<main className={`mx-auto flex w-full flex-col px-4 pb-8 md:px-8 ${wide ? "max-w-5xl" : "max-w-md"}`}>
				{children}
			</main>
		</div>
	);
}

function Notice({ title, text }: { title: string; text: string }) {
	return (
		<PublicDriveFrame>
			<div className="mt-16 rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-xs">
				<h1 className="text-lg font-semibold tracking-tight text-neutral-900">{title}</h1>
				<p className="mt-1.5 text-sm text-neutral-500">{text}</p>
			</div>
		</PublicDriveFrame>
	);
}

export function PublicDriveExpired() {
	return <Notice title="This link has expired" text="Ask the person who shared it with you for a new link." />;
}

export function PublicDriveMissing() {
	return <Notice title="This link is not available" text="It may have been removed or turned off." />;
}

export function PublicDriveError({ message }: { message: string }) {
	return <Notice title="Something went wrong" text={message} />;
}

/** Asks for the link password; the server sets an unlock cookie for this link on success. */
export function PublicDrivePassword({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!password) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/public/drive/${encodeURIComponent(token)}/unlock`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			if (response.ok) return onUnlocked();
			if (response.status === 401) setError("That password is not right.");
			else if (response.status === 429) setError("Too many attempts. Try again in a minute.");
			else setError("This link is not available.");
		} catch {
			setError("Could not reach the server.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<PublicDriveFrame>
			<form
				onSubmit={(event) => void submit(event)}
				className="mt-16 space-y-4 rounded-xl border border-neutral-200 bg-white p-8 shadow-xs"
			>
				<div className="flex items-center gap-2">
					<Lock size={18} className="text-neutral-500" />
					<h1 className="text-lg font-semibold tracking-tight text-neutral-900">This link needs a password</h1>
				</div>
				<label className="block space-y-1 text-sm">
					<span className="font-medium text-neutral-900">Password</span>
					<Input
						type="password"
						autoComplete="off"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoFocus
					/>
				</label>
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				<Button type="submit" disabled={busy || !password} className="w-full">
					{busy ? "Checking…" : "Open"}
				</Button>
			</form>
		</PublicDriveFrame>
	);
}
