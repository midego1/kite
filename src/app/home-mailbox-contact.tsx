"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, Check, Copy, Pencil, PenSquare, Search } from "lucide-react";
import { PersonAvatar } from "./home-mailbox-cards";
import { FOCUS_RING } from "./home-mailbox-sidebar";
import type { HomePerson } from "./home-mailbox-types";

/*
 * The contact card of a person chip in the reader, in the look and order of the app's card
 * (components/contacts/contact-card.tsx): avatar, name, address and Copy, then New email, a search for their mail,
 * Edit contact and Block contact. It is drawn here with local state instead of reusing that component, which would
 * bring the composer, search, router and contact requests into the home page. Nothing leaves the page: Copy uses
 * the clipboard, the rest acts in the mailbox.
 */

const ITEM = `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 ${FOCUS_RING}`;

type CardProps = {
	person: HomePerson;
	icon: string;
	left: number;
	onNewEmail: () => void;
	onSearch: () => void;
	onNote: () => void;
};

export function HomeContactCard({ person, icon, left, onNewEmail, onSearch, onNote }: CardProps) {
	const [copied, setCopied] = useState(false);
	const addressRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1800);
		return () => window.clearTimeout(timer);
	}, [copied]);

	// Without the clipboard API (plain http, as a Docker install is served) or its permission, select the address
	// instead; where execCommand still works that selection is copied, else it stays selected.
	const selectAddress = () => {
		const node = addressRef.current;
		if (!node) return;
		const range = document.createRange();
		range.selectNodeContents(node);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		setCopied(document.execCommand("copy"));
	};

	const copy = () => {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			void navigator.clipboard.writeText(person.address).then(() => setCopied(true), selectAddress);
			return;
		}
		selectAddress();
	};

	return (
		<div
			role="dialog"
			aria-label={`Contact card for ${person.name}`}
			data-contact-card
			style={{ left }}
			className="absolute top-full z-20 mt-2 w-[min(20rem,100%)] rounded-xl border border-neutral-200 bg-white p-2 text-neutral-900 shadow-lg"
		>
			<div className="flex items-center gap-3 px-3 pb-2 pt-2">
				<PersonAvatar person={person} icon={icon} size="lg" />
				<div className="min-w-0 flex-1">
					<p className="flex items-center gap-2 text-sm font-medium">
						<span className="truncate">{person.name}</span>
						{person.own && (
							<span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
								You
							</span>
						)}
					</p>
					<p ref={addressRef} className="break-all text-xs text-neutral-500">
						{person.address}
					</p>
				</div>
				<button
					type="button"
					onClick={copy}
					aria-label={copied ? "Address copied" : "Copy address"}
					className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 ${FOCUS_RING}`}
				>
					{copied ? (
						<Check className="h-3.5 w-3.5" aria-hidden="true" />
					) : (
						<Copy className="h-3.5 w-3.5" aria-hidden="true" />
					)}
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			{!person.own && (
				<>
					<hr className="my-1 border-neutral-100" />
					<button type="button" onClick={onNewEmail} className={ITEM}>
						<PenSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
						New email
					</button>
					<button type="button" onClick={onSearch} className={ITEM}>
						<Search className="h-4 w-4 shrink-0" aria-hidden="true" />
						<span className="min-w-0 truncate">Search Inbox for mail from {person.name}</span>
					</button>
					<button type="button" onClick={onNote} className={ITEM}>
						<Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
						Edit contact
					</button>
					<button type="button" onClick={onNote} className={ITEM}>
						<Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
						Block contact
					</button>
				</>
			)}
			<span aria-live="polite" className="sr-only">
				{copied ? "Address copied" : ""}
			</span>
		</div>
	);
}
