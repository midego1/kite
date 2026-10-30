"use client";

import { CalendarDays } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { formatUserDate } from "@/lib/time/utils";
import type { ThreadParticipant } from "./conversation-thread-utils";

const MAX_PARTICIPANT_CHIPS = 6;

function formatDay(date: string) {
	return formatUserDate(date, { month: "long", day: "numeric" });
}

/**
 * The top of the reader, after Zero's: the subject with the conversation's size, the date range and the
 * participants as chips with their avatars.
 */
export function ReaderThreadHeader({
	subject,
	count,
	range,
	participants,
	mailboxId,
}: {
	subject: string;
	count: number;
	range: { first: string; last: string } | null;
	participants: ThreadParticipant[];
	mailboxId: string | null;
}) {
	const firstDay = range ? formatDay(range.first) : null;
	const lastDay = range ? formatDay(range.last) : null;
	const shown = participants.slice(0, MAX_PARTICIPANT_CHIPS);
	const hidden = participants.length - shown.length;
	return (
		<div className="px-4 pb-5 pt-5 sm:px-7">
			<div className="flex items-baseline gap-2">
				<h1 dir="auto" className="min-w-0 text-xl font-medium text-neutral-900" title={subject}>
					{subject}
				</h1>
				{count > 1 && (
					<span aria-hidden="true" className="shrink-0 text-xl text-neutral-500">
						[{count}]
					</span>
				)}
			</div>
			{firstDay && (
				<p className="mt-1.5 flex items-center gap-2 text-sm text-neutral-500">
					<CalendarDays aria-hidden="true" className="h-4 w-4" />
					{firstDay === lastDay ? firstDay : `${firstDay} - ${lastDay}`}
				</p>
			)}
			{shown.length > 0 && (
				<ul aria-label="Participants" className="mt-4 flex flex-wrap items-center gap-2">
					{shown.map((person) => (
						<li
							key={person.address || person.name}
							title={person.address}
							className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 py-1 pl-1 pr-3 text-sm text-neutral-900"
						>
							<ContactAvatar
								mailboxId={mailboxId}
								address={person.address}
								name={person.name}
								className="h-6 w-6 text-[10px]"
							/>
							<span dir="auto" className="max-w-40 truncate">
								{person.name}
							</span>
						</li>
					))}
					{hidden > 0 && <li className="text-sm text-neutral-500">+{hidden}</li>}
				</ul>
			)}
		</div>
	);
}
