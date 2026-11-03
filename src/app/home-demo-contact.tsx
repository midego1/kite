"use client";

import { useEffect, useState } from "react";
import { Ban, Check, Copy, Pencil, PenSquare, Search } from "lucide-react";
import { demoMailbox } from "./home-demo-data";
import { FOCUS_RING } from "./home-demo-parts";
import type { DemoPerson } from "./home-demo-types";

/*
 * The contact card of a person chip in the demo's reader, in the look and order of the app's card
 * (components/contacts/contact-card.tsx): avatar, name, address and Copy, then New email, a search for their mail,
 * Edit contact and Block contact. It is drawn here with local state instead of reusing that component, which would
 * bring the composer, search, router and contact requests into the home page. Nothing leaves the page: Copy uses
 * the clipboard, the rest acts in the demo (home-demo-state-utils.ts).
 */

const ITEM = `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 ${FOCUS_RING}`;

export function DemoContactCard({ person, left }: { person: DemoPerson; left: number }) {
	const [copied, setCopied] = useState(false);
	const own = person.address === demoMailbox.address;

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1800);
		return () => window.clearTimeout(timer);
	}, [copied]);

	const copy = () => {
		// The clipboard may be refused (plain http, no permission); the card then simply stays as it was.
		void navigator.clipboard?.writeText(person.address).then(
			() => setCopied(true),
			() => undefined,
		);
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
				<span
					aria-hidden="true"
					className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium ${person.avatarClassName}`}
				>
					{person.initial}
				</span>
				<div className="min-w-0 flex-1">
					<p className="flex items-center gap-2 text-sm font-medium">
						<span className="truncate">{person.name}</span>
						{own && (
							<span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
								You
							</span>
						)}
					</p>
					<p className="break-all text-xs text-neutral-500">{person.address}</p>
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
			{!own && (
				<>
					<hr className="my-1 border-neutral-100" />
					<button type="button" data-action="contactNewEmail" data-id={person.address} className={ITEM}>
						<PenSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
						New email
					</button>
					<button type="button" data-action="contactSearch" data-id={person.address} className={ITEM}>
						<Search className="h-4 w-4 shrink-0" aria-hidden="true" />
						<span className="min-w-0 truncate">Search Inbox for mail from {person.name}</span>
					</button>
					<button type="button" data-action="contactNote" className={ITEM}>
						<Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
						Edit contact
					</button>
					<button type="button" data-action="contactNote" className={ITEM}>
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
