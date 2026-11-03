import { Sparkles } from "lucide-react";
import { FOCUS_RING } from "./home-mailbox-sidebar";
import type { HomePerson, HomeSample } from "./home-mailbox-types";

/* The pieces of an example mail that the app adds around the message: the avatar, the Example notice, the Screener bar and a suggestion. */

const PRIMARY = `rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 ${FOCUS_RING}`;
const SECONDARY = `rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100 ${FOCUS_RING}`;

/** The brand icon for the product, an initial in the person's colour for everyone else. */
export function PersonAvatar({ person, icon, size }: { person: HomePerson; icon: string; size: "sm" | "md" | "lg" }) {
	const box = size === "sm" ? "h-6 w-6 text-xs" : size === "md" ? "h-9 w-9 text-sm" : "h-10 w-10 text-sm";
	const image = size === "sm" ? 14 : size === "md" ? 20 : 22;
	return (
		<span
			aria-hidden="true"
			className={`flex shrink-0 items-center justify-center rounded-full font-medium ${box} ${
				person.brand ? "bg-neutral-200" : (person.avatarClassName ?? "bg-neutral-200 text-neutral-700")
			}`}
		>
			{person.brand ? <img src={icon} alt="" width={image} height={image} /> : person.initial}
		</span>
	);
}

/** The small label that marks a row or an email as an example. */
export function ExampleLabel() {
	return (
		<span className="shrink-0 rounded-full border border-neutral-300 px-2 py-px text-[11px] font-medium text-neutral-600">
			Example
		</span>
	);
}

export function ExampleNotice() {
	return (
		<p className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-600">
			<ExampleLabel />
			<span className="min-w-0 flex-1">
				An example mail: the people and addresses are invented, and nothing you do here leaves this page.
			</span>
		</p>
	);
}

type CardProps = {
	sample: HomeSample;
	onReview: () => void;
	onDismiss: () => void;
};

export function SuggestionCard({ sample, onReview, onDismiss }: CardProps) {
	if (!sample.suggestion) return null;
	return (
		<div className="rounded-xl border border-neutral-200 bg-[#f6f8fc] p-4">
			<p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
				<Sparkles className="h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
				<span className="min-w-0">{sample.suggestion.title}</span>
				<span className="ml-auto shrink-0 text-xs font-normal text-neutral-500">Suggestion, nothing sent</span>
			</p>
			<p className="mt-2 text-sm leading-6 text-neutral-700">{sample.suggestion.text}</p>
			<p className="mt-3 flex gap-2">
				<button type="button" onClick={onReview} className={PRIMARY}>
					{sample.suggestion.action}
				</button>
				<button type="button" onClick={onDismiss} className={SECONDARY}>
					Dismiss
				</button>
			</p>
		</div>
	);
}

export function ScreenerBar({ sender, onDecide }: { sender: HomePerson; onDecide: (approve: boolean) => void }) {
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<span className="min-w-0 flex-1">
				<strong>{sender.name}</strong> is new. Decide once whether you want their mail.
			</span>
			<span className="flex gap-2">
				<button type="button" onClick={() => onDecide(true)} className={PRIMARY}>
					Approve
				</button>
				<button type="button" onClick={() => onDecide(false)} className={SECONDARY}>
					Deny
				</button>
			</span>
		</div>
	);
}
