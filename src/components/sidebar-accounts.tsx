"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Check, PanelLeft, Plus } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn } from "@/lib/utils";
import { getMailboxAddress } from "./mailbox-selector-utils";
import { MailboxAvatar } from "./sidebar-mailbox-switcher";
import { useSidebar } from "./sidebar-state";
import { Tooltip } from "./ui/tooltip";

/** Mailboxes shown as squares at the top of the sidebar; the rest stay in the switcher's list. */
const MAX_MAILBOX_SQUARES = 4;

function CollapseButton() {
	const { minimal, toggle } = useSidebar();
	const label = minimal ? "Expand menu" : "Collapse menu";
	return (
		<Tooltip label={label} placement="right">
			<button
				type="button"
				onClick={toggle}
				aria-label={label}
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900"
			>
				<PanelLeft size={16} />
			</button>
		</Tooltip>
	);
}

/**
 * The top of the mail sidebar, after Zero's account row: one square per mailbox (the current one checked), a
 * "+" for admins, the account menu and the collapse button. In the icon rail only the collapse button stays.
 */
export function SidebarAccounts({ accountMenu }: { accountMenu?: ReactNode }) {
	const { selectedMailbox, setSelectedMailbox, mailboxes } = useSelectedMailbox();
	const { minimal } = useSidebar();
	const user = useCurrentUser();
	const router = useRouter();
	if (minimal) {
		return (
			<div className="mb-3 flex flex-col items-center gap-2">
				<CollapseButton />
			</div>
		);
	}
	const squares = mailboxes.slice(0, MAX_MAILBOX_SQUARES);
	return (
		<div className="mb-3 flex h-10 items-center gap-1.5 px-2">
			{squares.map((mailbox) => {
				const active = mailbox.id === selectedMailbox?.id;
				return (
					<Tooltip key={mailbox.id} label={getMailboxAddress(mailbox)}>
						<button
							type="button"
							aria-label={`Open ${getMailboxAddress(mailbox)}`}
							aria-pressed={active}
							onClick={() => {
								if (active) return;
								setSelectedMailbox(mailbox);
								router.push("/inbox");
							}}
							className={cn(
								"relative flex h-8 w-8 items-center justify-center rounded-lg",
								active ? "ring-1 ring-neutral-300" : "opacity-70 hover:opacity-100",
							)}
						>
							<MailboxAvatar mailbox={mailbox} className="h-7 w-7 rounded-md text-xs" />
							{active && (
								<span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 ring-2 ring-[var(--background)]">
									<Check className="h-2.5 w-2.5 text-[#fff]" strokeWidth={3} />
								</span>
							)}
						</button>
					</Tooltip>
				);
			})}
			{user?.role === "admin" && (
				<Tooltip label="Add mailbox">
					<Link
						href="/mailboxes"
						aria-label="Add mailbox"
						className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
					>
						<Plus size={16} />
					</Link>
				</Tooltip>
			)}
			<span className="flex-1" />
			{accountMenu && (
				<span className="flex shrink-0 items-center [&>div>button]:p-0.5 [&>div>button>*]:h-7 [&>div>button>*]:w-7 [&>div>button>*]:text-xs">
					{accountMenu}
				</span>
			)}
			<CollapseButton />
		</div>
	);
}
