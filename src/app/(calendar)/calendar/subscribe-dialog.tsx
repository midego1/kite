"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import type { CalendarFeedStatus } from "@/lib/calendar/feed-types";
import type { CalendarSubscribeDialogProps } from "./subscribe-dialog-types";

type FeedResponse = { feed?: CalendarFeedStatus; path?: string; error?: string };

async function feedRequest(method: "GET" | "POST" | "DELETE"): Promise<FeedResponse> {
	const response = await authFetch("/api/calendar/feed", { method });
	const data = (await response.json().catch(() => ({}))) as FeedResponse;
	if (!response.ok) throw new Error(data.error || "The subscription link could not be updated");
	return data;
}

function SubscribeSteps() {
	return (
		<ul className="list-disc space-y-1.5 ps-5 text-sm text-neutral-700">
			<li>
				<strong className="font-medium text-neutral-900">Google Calendar</strong> (on a computer): next to Other
				calendars, choose + and then From URL, and paste the link.
			</li>
			<li>
				<strong className="font-medium text-neutral-900">Outlook</strong>: choose Add calendar, then Subscribe from web,
				and paste the link.
			</li>
			<li>
				<strong className="font-medium text-neutral-900">iPhone or iPad</strong>: open Settings, Apps, Calendar,
				Calendar Accounts, Add Account, Other, Add Subscribed Calendar, and paste the link. On a Mac, choose File, New
				Calendar Subscription in Calendar.
			</li>
		</ul>
	);
}

/** Creates, replaces and turns off the read-only link other calendar apps subscribe to. */
export function CalendarSubscribeDialog({ open, onOpenChange }: CalendarSubscribeDialogProps) {
	const confirm = useConfirm();
	const [feed, setFeed] = useState<CalendarFeedStatus | null>(null);
	const [url, setUrl] = useState("");
	const [copied, setCopied] = useState(false);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		feedRequest("GET")
			.then((data) => {
				if (!cancelled) setFeed(data.feed ?? null);
			})
			.catch((error: unknown) => {
				if (!cancelled)
					toast.error(error instanceof Error ? error.message : "The subscription link could not be loaded");
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	async function run(method: "POST" | "DELETE") {
		setPending(true);
		try {
			const data = await feedRequest(method);
			setFeed(data.feed ?? null);
			setCopied(false);
			setUrl(data.path ? `${window.location.origin}${data.path}` : "");
			if (method === "DELETE") toast.success("Subscription link turned off");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "The subscription link could not be updated");
		} finally {
			setPending(false);
		}
	}

	async function replace() {
		const confirmed = await confirm({
			title: "Replace the subscription link?",
			description: "Calendars subscribed with the current link stop updating. Subscribe again with the new link.",
			confirmLabel: "Replace link",
		});
		if (confirmed) await run("POST");
	}

	async function turnOff() {
		const confirmed = await confirm({
			title: "Turn off the subscription link?",
			description: "Calendars subscribed with this link stop updating. Your events in Kite are not changed.",
			confirmLabel: "Turn off",
		});
		if (confirmed) await run("DELETE");
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			toast.success("Link copied");
		} catch {
			toast.error("Copy failed; select the link and copy it yourself");
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setUrl("");
					setCopied(false);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(560px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Subscribe from another calendar app</DialogTitle>
					<DialogDescription>
						Show your Kite events in Google Calendar, Outlook or on your phone. The other app can only read them, and it
						checks for changes every few hours.
					</DialogDescription>
				</DialogHeader>
				<div className="mt-4 space-y-4 text-sm text-neutral-700">
					{url ? (
						<>
							<div className="flex items-center gap-2">
								<Input
									readOnly
									value={url}
									aria-label="Subscription link"
									onFocus={(event) => event.currentTarget.select()}
									className="min-w-0 flex-1 text-xs"
								/>
								<Button type="button" variant="outline" className="shrink-0" onClick={() => void copy()}>
									{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
									{copied ? "Copied" : "Copy"}
								</Button>
							</div>
							<Notice tone="warning" role="none">
								Copy the link now: Kite shows it only once. Anyone with the link can see your events, so share it with
								no one.
							</Notice>
							<SubscribeSteps />
						</>
					) : feed?.active ? (
						<>
							<p>
								A subscription link is on, created {formatUserDate(feed.createdAt ?? "", { dateStyle: "medium" })}
								{feed.lastUsedAt
									? ` and last read ${formatUserDate(feed.lastUsedAt, { dateStyle: "medium", timeStyle: "short" })}`
									: " and not read yet"}
								. Kite cannot show it again; to subscribe somewhere else, replace it with a new link.
							</p>
							<div className="flex flex-wrap gap-2">
								<Button type="button" disabled={pending} onClick={() => void replace()}>
									Replace link
								</Button>
								<Button type="button" variant="outline" disabled={pending} onClick={() => void turnOff()}>
									Turn off link
								</Button>
							</div>
						</>
					) : (
						<>
							<p>
								Kite makes a private link to a read-only copy of your calendar. It works until you replace it or turn it
								off here.
							</p>
							<Button type="button" disabled={pending || !feed} onClick={() => void run("POST")}>
								Create subscription link
							</Button>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
