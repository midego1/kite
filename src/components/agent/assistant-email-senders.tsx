"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	addSenderAddress,
	loadSenderAddresses,
	removeSenderAddress,
	verifySenderAddress,
	type SenderAddress,
} from "./assistant-email-senders-utils";

/**
 * Verified extra addresses a request may come from besides the user's own mailboxes (spec §5.3, §13, §14): add
 * one, enter the code Kite emails to it, or remove it. At most five; the server enforces the cap and never says
 * whether an address belongs to someone else.
 */
export function AssistantEmailSenders() {
	const [addresses, setAddresses] = useState<SenderAddress[] | null>(null);
	const [newAddress, setNewAddress] = useState("");
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

	function refresh() {
		loadSenderAddresses()
			.then(setAddresses)
			.catch((error: unknown) =>
				setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load" }),
			);
	}

	useEffect(refresh, []);

	async function add() {
		if (!newAddress.trim()) return;
		setBusy(true);
		setMessage(null);
		try {
			await addSenderAddress(newAddress.trim());
			setMessage({ tone: "ok", text: "If that address can be added, a code was sent to it." });
			setNewAddress("");
			refresh();
		} catch (error) {
			setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to add that address" });
		} finally {
			setBusy(false);
		}
	}

	async function verify(id: string) {
		if (!code.trim()) return;
		setBusy(true);
		setMessage(null);
		try {
			await verifySenderAddress(id, code.trim());
			setCode("");
			setPendingId(null);
			refresh();
		} catch (error) {
			setMessage({ tone: "error", text: error instanceof Error ? error.message : "That code is wrong or has expired" });
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: string) {
		setBusy(true);
		try {
			await removeSenderAddress(id);
			refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-2 rounded-2xl border border-neutral-200 p-3">
			<p className="font-medium text-neutral-800">Verified extra addresses</p>
			<p className="text-xs text-neutral-500">
				Reach the assistant from another address you own, such as your phone&apos;s mail account, once you verify it.
			</p>
			<ul className="space-y-1 text-sm">
				{addresses?.map((item) => (
					<li key={item.id} className="flex items-center justify-between gap-2">
						<span className="truncate">
							{item.address} {item.verified ? "✓" : "(code sent)"}
						</span>
						<div className="flex items-center gap-2">
							{!item.verified && pendingId !== item.id && (
								<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPendingId(item.id)}>
									Enter code
								</Button>
							)}
							<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void remove(item.id)}>
								Remove
							</Button>
						</div>
					</li>
				))}
			</ul>
			{pendingId && (
				<div className="flex items-center gap-2">
					<input
						className="w-32 rounded-xl border border-neutral-200 p-2 outline-none focus:border-blue-400"
						placeholder="Code"
						value={code}
						disabled={busy}
						onChange={(event) => setCode(event.target.value)}
						aria-label="Verification code"
					/>
					<Button type="button" size="sm" disabled={busy || !code.trim()} onClick={() => void verify(pendingId)}>
						Verify
					</Button>
				</div>
			)}
			{(!addresses || addresses.length < 5) && (
				<div className="flex items-center gap-2">
					<input
						className="flex-1 rounded-xl border border-neutral-200 p-2 outline-none focus:border-blue-400"
						type="email"
						placeholder="name@example.com"
						value={newAddress}
						disabled={busy}
						onChange={(event) => setNewAddress(event.target.value)}
						aria-label="New address"
					/>
					<Button type="button" size="sm" disabled={busy || !newAddress.trim()} onClick={() => void add()}>
						Add
					</Button>
				</div>
			)}
			{message && (
				<p role="status" className={`text-xs ${message.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
					{message.text}
				</p>
			)}
		</div>
	);
}
