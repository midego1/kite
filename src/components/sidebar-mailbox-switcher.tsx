"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Settings2, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";
import { getAccountInitial, getMailboxAddress, getMailboxName } from "./mailbox-selector-utils";
import { useSidebar } from "./sidebar-state";
import { AllMailboxesFilter, AllMailboxesIcon, AllMailboxesOption } from "./all-mailboxes-option";
import { ALL_MAILBOXES_LABEL } from "./messages/utils";

function MailboxAvatar({ mailbox, className }: { mailbox: MailboxOption; className?: string }) {
	const [failed, setFailed] = useState(false);
	const name = getMailboxName(mailbox);
	return (
		<span
			className={cn(
				"relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md text-[11px] font-semibold text-white",
				className,
			)}
			style={getAvatarColorStyle(getMailboxAddress(mailbox))}
			aria-hidden
		>
			{getAccountInitial(name)}
			{mailbox.hasAvatar && !failed && (
				<ProgressiveAvatarImage
					src={`/api/mailboxes/${mailbox.id}/avatar`}
					alt=""
					className="absolute inset-0 h-full w-full object-cover"
					onError={() => setFailed(true)}
				/>
			)}
		</span>
	);
}

type MenuAnchor = { top: number; left: number; width: number; container: HTMLElement };

/**
 * Where the menu opens: fixed under the button in <body>, or, inside the phone menu sheet (a modal
 * dialog that blocks clicks outside it), inside the sheet and positioned relative to it.
 */
function menuAnchor(button: HTMLElement): MenuAnchor {
	const rect = button.getBoundingClientRect();
	const width = Math.min(Math.max(rect.width, 320), window.innerWidth - rect.left - 12);
	const dialog = button.closest<HTMLElement>('[role="dialog"]');
	const origin = dialog?.getBoundingClientRect() ?? { top: 0, left: 0 };
	return {
		top: rect.bottom + 6 - origin.top,
		left: rect.left - origin.left,
		width,
		container: dialog ?? document.body,
	};
}

/** Switches the active mailbox from the top of the sidebar, without opening the account menu. */
export function SidebarMailboxSwitcher() {
	const { selectedMailbox, setSelectedMailbox, mailboxes, allMailboxes, setAllMailboxes } = useSelectedMailbox();
	const { minimal } = useSidebar();
	const user = useCurrentUser();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
	const { counts } = useMessageCounts(null, open);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		function close() {
			setOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	function toggleMenu() {
		if (ref.current) setAnchor(menuAnchor(ref.current));
		setOpen((value) => !value);
	}

	if (minimal || !selectedMailbox) return null;

	return (
		<div ref={ref} className="relative mb-3 ml-3">
			<button
				type="button"
				onClick={toggleMenu}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`Switch mailbox, current: ${allMailboxes ? ALL_MAILBOXES_LABEL : getMailboxAddress(selectedMailbox)}`}
				className="flex h-10 w-full items-center gap-2.5 rounded-xl border max-md:h-11 border-neutral-200 bg-white px-3 text-left text-sm transition-colors hover:border-neutral-300"
			>
				{allMailboxes ? <AllMailboxesIcon /> : <MailboxAvatar mailbox={selectedMailbox} />}
				<span className="min-w-0 flex-1 truncate font-medium text-neutral-900">
					{allMailboxes ? ALL_MAILBOXES_LABEL : getMailboxName(selectedMailbox)}
				</span>
				<ChevronsUpDown className="h-4 w-4 shrink-0 text-neutral-400" />
			</button>
			{open &&
				anchor &&
				createPortal(
					// Portalled out of the sidebar, which clips overflow and, on phones, is transformed, which would trap a fixed menu.
					<div
						ref={menuRef}
						style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
						className={cn(
							anchor.container === document.body ? "fixed" : "absolute",
							"z-[200] max-h-[70vh] overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-neutral-900/15",
						)}
						role="listbox"
						aria-label="Mailboxes"
					>
						<AllMailboxesOption
							counts={counts.mailboxes}
							onSelect={() => {
								setOpen(false);
								if (allMailboxes) return;
								setAllMailboxes(true);
								router.push("/inbox");
							}}
						/>
						<AllMailboxesFilter />
						{mailboxes.map((mailbox) => {
							const active = !allMailboxes && mailbox.id === selectedMailbox.id;
							const unread = counts.mailboxes.find((count) => count.mailboxId === mailbox.id)?.unread ?? 0;
							return (
								<button
									key={mailbox.id}
									type="button"
									role="option"
									aria-selected={active}
									onClick={() => {
										setOpen(false);
										if (active) return;
										setSelectedMailbox(mailbox);
										setAllMailboxes(false);
										router.push("/inbox");
									}}
									className={cn(
										"flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-neutral-100",
										active && "bg-blue-50",
									)}
								>
									<MailboxAvatar mailbox={mailbox} className="h-7 w-7" />
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-900">
											{getMailboxName(mailbox)}
											{mailbox.type === "shared" && (
												<UsersRound className="h-3.5 w-3.5 shrink-0 text-blue-600" aria-label="Shared inbox" />
											)}
										</span>
										<span className="block truncate text-xs text-neutral-500">{getMailboxAddress(mailbox)}</span>
									</span>
									{unread > 0 && (
										<span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">
											{unread > 99 ? "99+" : unread}
										</span>
									)}
									{active && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
								</button>
							);
						})}
						{user?.role === "admin" && (
							<Link
								href="/mailboxes"
								onClick={() => setOpen(false)}
								className="mt-1 flex items-center gap-2.5 border-t border-neutral-100 px-2 pb-1 pt-2.5 text-sm text-neutral-600 hover:text-neutral-900"
							>
								<Settings2 className="h-4 w-4" />
								Manage mailboxes
							</Link>
						)}
					</div>,
					anchor.container,
				)}
		</div>
	);
}
