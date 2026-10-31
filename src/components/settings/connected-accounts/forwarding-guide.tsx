"use client";

import { forwardRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
	FORWARDING_CHECKS,
	FORWARDING_PROVIDERS,
	forwardingStepParts,
	type ForwardingProviderId,
} from "./forwarding-guide-utils";

/**
 * The forwarding guide (spec §6.1): forward mail at the provider to a Kite address, with no password stored. Shown
 * on Settings → Connected accounts, and opened from the connect dialog where connecting is not possible (Microsoft).
 */
export const ForwardingGuide = forwardRef<
	HTMLElement,
	{ provider: ForwardingProviderId; onProviderChange: (provider: ForwardingProviderId) => void }
>(function ForwardingGuide({ provider, onProviderChange }, ref) {
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const [mailboxId, setMailboxId] = useState<string | null>(null);
	const target = mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? selectedMailbox ?? mailboxes[0];
	const address = target ? getMailboxAddress(target) : "your Kite address";
	const guide = FORWARDING_PROVIDERS.find((entry) => entry.id === provider) ?? FORWARDING_PROVIDERS[0];
	const [copied, setCopied] = useState(false);

	return (
		<section
			ref={ref}
			id="forwarding"
			aria-labelledby="forwarding-guide-title"
			className="space-y-4 rounded-xl border border-neutral-200 bg-white p-4"
			data-forwarding-guide
		>
			<div className="space-y-1">
				<h2 id="forwarding-guide-title" className="text-sm font-semibold text-neutral-900">
					Or forward mail to Kite
				</h2>
				<p className="text-xs text-neutral-500">
					Forwarding needs no password in Kite and delivers each message the moment it arrives. Set it up at the
					provider once; Kite only receives.
				</p>
			</div>
			{mailboxes.length > 1 && (
				<div className="max-w-sm space-y-2">
					<Label htmlFor="forwarding-mailbox">Forward to</Label>
					<Select
						id="forwarding-mailbox"
						containerClassName="w-full"
						className="h-9 text-sm"
						value={target?.id ?? ""}
						onChange={(event) => setMailboxId(event.target.value)}
					>
						{mailboxes.map((mailbox) => (
							<option key={mailbox.id} value={mailbox.id}>
								{getMailboxName(mailbox) === getMailboxAddress(mailbox)
									? getMailboxAddress(mailbox)
									: `${getMailboxName(mailbox)} (${getMailboxAddress(mailbox)})`}
							</option>
						))}
					</Select>
				</div>
			)}
			{target && (
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="text-neutral-600">Your Kite address:</span>
					<code className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-900" data-forwarding-address>
						{address}
					</code>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => {
							void navigator.clipboard?.writeText(address).then(() => setCopied(true));
						}}
					>
						{copied ? "Copied" : "Copy"}
					</Button>
				</div>
			)}
			<div role="group" aria-label="Provider" className="flex flex-wrap gap-2">
				{FORWARDING_PROVIDERS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						aria-pressed={entry.id === guide.id}
						onClick={() => onProviderChange(entry.id)}
						className={cn(
							"rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600",
							entry.id === guide.id
								? "bg-blue-500 text-[#fff]"
								: "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900",
						)}
					>
						{entry.name}
					</button>
				))}
			</div>
			<div className="space-y-3" data-forwarding-provider={guide.id}>
				{guide.notes.map((note) => (
					<p key={note} className="text-xs text-[#8a4b0a] dark:text-[#d4a35a]">
						{note}
					</p>
				))}
				<ol className="list-decimal space-y-1.5 pl-5 text-sm text-neutral-700">
					{guide.steps.map((step) => (
						<li key={step}>
							{forwardingStepParts(step, address).map((part, index) =>
								part.address ? (
									<code key={index} className="rounded bg-neutral-100 px-1 text-neutral-900">
										{part.text}
									</code>
								) : (
									<span key={index}>{part.text}</span>
								),
							)}
						</li>
					))}
				</ol>
				{(guide.settings.length > 0 || guide.help) && (
					<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
						{guide.settings.map((link) => (
							<a
								key={link.url}
								href={link.url}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-blue-600 underline underline-offset-2"
							>
								{link.label}
								<ExternalLink aria-hidden="true" className="h-3 w-3" />
							</a>
						))}
						{guide.help && (
							<a
								href={guide.help}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-blue-600 underline underline-offset-2"
							>
								{guide.name} help
								<ExternalLink aria-hidden="true" className="h-3 w-3" />
							</a>
						)}
					</div>
				)}
			</div>
			<div className="space-y-1.5">
				<h3 className="text-xs font-semibold text-neutral-900">Check that it works</h3>
				<ul className="list-disc space-y-1 pl-5 text-xs text-neutral-600">
					{FORWARDING_CHECKS.map((check) => (
						<li key={check}>{check}</li>
					))}
				</ul>
			</div>
		</section>
	);
});
