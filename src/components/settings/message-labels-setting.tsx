"use client";

import { Link2 } from "lucide-react";
import { LabelDot } from "@/components/messages/label-dot";
import { MESSAGE_LABEL_OPTIONS, isMessageListLabels } from "@/components/messages/reading-layout-utils";
import { useMessageListLabels } from "@/components/messages/use-reading-layout";
import { SettingRow } from "@/components/ui/page";
import { Select } from "@/components/ui/select";
import type { MessageListLabels } from "@/components/messages/reading-layout-types";

/** A line under the setting that shows what each marker in the rows means, in the look that is chosen. */
function Legend({ labels }: { labels: MessageListLabels }) {
	if (labels === "off") return <span className="mt-1 block text-xs">Rows carry no mailbox or account marker.</span>;
	const item = "inline-flex items-center gap-1.5";
	return (
		<span data-labels-legend={labels} className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
			{labels === "compact" ? (
				<>
					<span className={item}>
						<LabelDot color="#3070f0" /> The mailbox the mail is in
					</span>
					<span className={item}>
						<Link2 aria-hidden className="h-3.5 w-3.5" /> Came in through a connected account
					</span>
				</>
			) : (
				<>
					<span className={item}>
						<span className="rounded-full bg-neutral-100 px-2 text-[11px] font-medium text-neutral-600">
							Mailbox: Work
						</span>
						The mailbox the mail is in
					</span>
					<span className={item}>
						<span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 text-[11px] font-medium text-neutral-600">
							<Link2 aria-hidden className="h-3 w-3" /> via Gmail
						</span>
						Came in through a connected account
					</span>
				</>
			)}
		</span>
	);
}

/** How message list rows mark their mailbox and connected account; the open message always shows the full labels. */
export function MessageLabelsSetting() {
	const [labels, setLabels] = useMessageListLabels();
	const current = MESSAGE_LABEL_OPTIONS.find((option) => option.value === labels);

	return (
		<SettingRow
			label="Labels in the message list"
			description={
				<>
					{current?.description} The open message always shows both in full.
					<Legend labels={labels} />
				</>
			}
			control={
				<Select
					value={labels}
					aria-label="Labels in the message list"
					className="py-1.5 text-sm text-neutral-900"
					onChange={(event) => {
						if (isMessageListLabels(event.target.value)) setLabels(event.target.value);
					}}
				>
					{MESSAGE_LABEL_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</Select>
			}
		/>
	);
}
