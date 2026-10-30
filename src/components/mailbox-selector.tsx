"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
	Check,
	ChevronDown,
	ChevronUp,
	Inbox,
	LogOut,
	Settings,
	ShieldCheck,
	UserPlus,
	UsersRound,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useDismissible } from "@/components/use-dismissible";
import { useMenuAnchor } from "@/components/use-menu-anchor";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { ModuleMenuLinks } from "@/components/modules/module-nav-links";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { isIdentityMailbox } from "@/components/mailbox-provider-utils";
import { useSidebar } from "@/components/sidebar-state";
import { RAIL_ITEM_CLASS, RAIL_TOOLTIP_CLASS } from "@/components/sidebar-rail-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useAuthMe } from "@/hooks/use-auth-me";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { logoutClientSession } from "@/lib/auth/logout";
import { fetchBrowserAccounts, switchBrowserAccount, type BrowserAccount } from "@/lib/auth/accounts-client";
import { PROFILE_AVATAR_CHANGED_EVENT, getProfileAvatarUrl } from "@/lib/profile/avatar-client";
import { PROFILE_NAME_CHANGED_EVENT } from "@/lib/profile/name-client";
import type { ProfileAvatarChangedDetail, ProfileNameChangedDetail } from "@/lib/profile/types";
import { MAILBOX_AVATAR_CHANGED_EVENT } from "@/lib/mailboxes/avatar-client";
import type { MailboxAvatarChangedDetail } from "@/lib/mailboxes/avatar-client-types";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ReadingLayoutMenu } from "@/components/reading-layout-menu";
import type {
	AccountAvatarProps,
	MailboxAccountRowProps,
	MailboxSelectorUser,
	MailboxSelectorProps,
} from "./mailbox-selector-types";
import { getAccountInitial, getMailboxAddress, getMailboxName, isAdminPath } from "./mailbox-selector-utils";

const UNSYNCED_SESSION = Symbol("unsynced");

function AccountAvatar({
	name,
	colorSeed = name,
	hasAvatar = false,
	avatarUrl = "/api/profile/avatar",
	size = "small",
	onAvatarError,
}: AccountAvatarProps) {
	const sizeClass =
		size === "large" ? "h-16 w-16 text-xl" : size === "compact" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
	const [imageFailed, setImageFailed] = useState(false);

	if (useKeyChanged(`${avatarUrl}|${hasAvatar}`)) setImageFailed(false);

	if (hasAvatar && !imageFailed) {
		return (
			<ProgressiveAvatarImage
				src={avatarUrl}
				alt={`${name} profile picture`}
				className={`${sizeClass} shrink-0 rounded-full border border-neutral-200 object-cover`}
				onError={() => {
					setImageFailed(true);
					onAvatarError?.();
				}}
			/>
		);
	}

	return (
		<div
			className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-blue-600 font-semibold text-white`}
			style={getAvatarColorStyle(colorSeed)}
			aria-hidden="true"
		>
			{getAccountInitial(name)}
		</div>
	);
}

function MailboxAccountRow({ mailbox, unread, avatarUrl, onSelect }: MailboxAccountRowProps) {
	const name = getMailboxName(mailbox);

	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white"
		>
			<AccountAvatar
				name={name}
				colorSeed={getMailboxAddress(mailbox)}
				hasAvatar={!!mailbox.hasAvatar || !!avatarUrl}
				avatarUrl={avatarUrl ?? `/api/mailboxes/${mailbox.id}/avatar`}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<p className="truncate text-sm font-semibold text-neutral-900">{name}</p>
					{mailbox.type === "shared" && (
						<Tooltip label="Shared inbox">
							<span title="Shared inbox" aria-label="Shared inbox" className="shrink-0 text-blue-600">
								<UsersRound className="h-3.5 w-3.5" />
							</span>
						</Tooltip>
					)}
				</div>
				<p className="truncate text-xs text-neutral-500">{getMailboxAddress(mailbox)}</p>
			</div>
			{unread > 0 && (
				<span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
		</button>
	);
}

/** The menu's last group: Admin (for admins), Add another account and Sign out. */
function AccountMenuActions({
	isAdmin,
	adminActive,
	onNavigate,
	onLogout,
}: {
	isAdmin: boolean;
	adminActive: boolean;
	onNavigate: () => void;
	onLogout: () => void;
}) {
	return (
		<div className="mt-2 overflow-hidden rounded-lg bg-white">
			{isAdmin && (
				<Link
					href="/admin"
					onClick={() => onNavigate()}
					className={`flex items-center gap-3 border-t border-neutral-100 px-5 py-4 text-sm font-medium text-neutral-800 hover:bg-[#f2f6fc] ${adminActive ? "bg-blue-50" : ""}`}
				>
					<ShieldCheck size={18} className="text-neutral-600" />
					Admin
					{adminActive && <Check className="ml-auto h-4 w-4 text-blue-600" />}
				</Link>
			)}
			<Link
				href="/login?add=1"
				onClick={() => onNavigate()}
				className="flex items-center gap-3 px-5 py-4 text-sm font-medium text-neutral-800 hover:bg-[#f2f6fc]"
			>
				<UserPlus size={18} className="text-neutral-600" />
				Add another account
			</Link>
			<button
				type="button"
				onClick={onLogout}
				className="flex w-full items-center gap-3 border-t border-neutral-100 px-5 py-4 text-left text-sm font-medium text-neutral-800 hover:bg-[#f2f6fc]"
			>
				<LogOut size={18} className="text-neutral-600" />
				Sign out
			</button>
		</div>
	);
}

/**
 * The account button. In the expanded sidebar it is a row with the mailbox name and address; in the icon rail
 * (with a tooltip) and everywhere else it is the avatar alone.
 */
function AccountTrigger({
	open,
	onClick,
	inSidebar,
	minimal,
	name,
	email,
	avatar,
}: {
	open: boolean;
	onClick: () => void;
	inSidebar: boolean;
	minimal: boolean;
	name: string;
	email: string;
	avatar: AccountAvatarProps;
}) {
	const row = inSidebar && !minimal;
	const rail = inSidebar && minimal;
	const button = (
		<button
			type="button"
			onClick={onClick}
			className={
				row
					? "flex w-full items-center gap-2 rounded-lg p-1 pr-2 text-left transition-colors hover:bg-neutral-200/60"
					: rail
						? `${RAIL_ITEM_CLASS} transition-colors hover:bg-neutral-200/60`
						: "rounded-full p-1 transition-colors hover:bg-neutral-200"
			}
			// The visible name and address stay in the accessible name (WCAG 2.5.3 Label in Name).
			aria-label={row ? `Open account menu, ${name} ${email}` : "Open account menu"}
			aria-haspopup="menu"
			aria-expanded={open}
		>
			<AccountAvatar {...avatar} size={row || rail ? "compact" : "small"} />
			{row && (
				<>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm font-medium text-neutral-900">{name}</span>
						<span className="block truncate text-xs text-neutral-500">{email}</span>
					</span>
					<ChevronUp size={16} aria-hidden="true" className="shrink-0 text-neutral-500" />
				</>
			)}
		</button>
	);
	return rail ? (
		<Tooltip label="Account menu" placement="right" className={RAIL_TOOLTIP_CLASS}>
			{button}
		</Tooltip>
	) : (
		button
	);
}

export function MailboxSelector({ initialUser, placement }: MailboxSelectorProps = {}) {
	const { selectedMailbox, setSelectedMailbox, allMailboxes, setAllMailboxes, mailboxes, isLoading } =
		useSelectedMailbox();
	const pathname = usePathname();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [user, setUser] = useState<MailboxSelectorUser | null>(initialUser ?? null);
	const [hasAvatar, setHasAvatar] = useState(!!initialUser?.hasAvatar);
	const [avatarUrl, setAvatarUrl] = useState("/api/profile/avatar");
	const [mailboxAvatarUrls, setMailboxAvatarUrls] = useState<Record<string, string>>({});
	const [inboxesOpen, setInboxesOpen] = useState(false);
	const [browserAccounts, setBrowserAccounts] = useState<BrowserAccount[]>([]);
	// In the sidebar the account sits at the bottom: the menu opens upward from where the button was.
	const { minimal } = useSidebar();

	useEffect(() => {
		if (!open) return;
		let active = true;
		void fetchBrowserAccounts().then((accounts) => {
			if (active) setBrowserAccounts(accounts);
		});
		return () => {
			active = false;
		};
	}, [open]);
	const otherAccounts = browserAccounts.filter((account) => !account.active && account.userId !== user?.id);
	const ref = useRef<HTMLDivElement>(null);
	const { counts } = useMessageCounts(null, open);

	useDismissible(open, () => setOpen(false), ref);
	const { anchor, measure } = useMenuAnchor(open, ref);

	const session = useAuthMe();
	const [syncedSession, setSyncedSession] = useState<unknown>(UNSYNCED_SESSION);
	if (!session.isPending && session.data !== syncedSession) {
		setSyncedSession(session.data);
		const sessionUser: MailboxSelectorUser | null = session.data?.user ?? null;
		setUser(sessionUser);
		setHasAvatar(!!sessionUser?.hasAvatar);
	}

	useEffect(() => {
		function onAvatarChanged(event: Event) {
			const detail = (event as CustomEvent<ProfileAvatarChangedDetail>).detail;
			setAvatarUrl(detail?.url ?? getProfileAvatarUrl());
			setHasAvatar(true);
			setMailboxAvatarUrls((current) => {
				const next = { ...current };
				const version = Date.now();
				for (const mailbox of mailboxes) {
					if (isIdentityMailbox(mailbox)) {
						next[mailbox.id] = `/api/mailboxes/${mailbox.id}/avatar?v=${version}`;
					}
				}
				return next;
			});
		}

		window.addEventListener(PROFILE_AVATAR_CHANGED_EVENT, onAvatarChanged);
		return () => window.removeEventListener(PROFILE_AVATAR_CHANGED_EVENT, onAvatarChanged);
	}, [mailboxes]);

	useEffect(() => {
		function onNameChanged(event: Event) {
			const { name } = (event as CustomEvent<ProfileNameChangedDetail>).detail;
			setUser((current) => (current ? { ...current, name } : current));
		}

		window.addEventListener(PROFILE_NAME_CHANGED_EVENT, onNameChanged);
		return () => window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, onNameChanged);
	}, []);

	useEffect(() => {
		function onMailboxAvatarChanged(event: Event) {
			const detail = (event as CustomEvent<MailboxAvatarChangedDetail>).detail;
			if (!detail?.mailboxId || !detail.url) return;
			setMailboxAvatarUrls((current) => ({
				...current,
				[detail.mailboxId]: detail.url,
			}));
		}

		window.addEventListener(MAILBOX_AVATAR_CHANGED_EVENT, onMailboxAvatarChanged);
		return () => window.removeEventListener(MAILBOX_AVATAR_CHANGED_EVENT, onMailboxAvatarChanged);
	}, []);

	if (isLoading && !initialUser) {
		return <Skeleton className="h-10 w-10 rounded-full" />;
	}

	const selectedName = selectedMailbox ? getMailboxName(selectedMailbox) : (user?.name ?? "Account");
	const selectedEmail = selectedMailbox ? getMailboxAddress(selectedMailbox) : (user?.email ?? "");
	const selectedMailboxAvatarUrl = selectedMailbox ? mailboxAvatarUrls[selectedMailbox.id] : undefined;
	const selectedHasAvatar = selectedMailbox ? !!selectedMailbox.hasAvatar || !!selectedMailboxAvatarUrl : hasAvatar;
	const selectedAvatarUrl = selectedMailbox
		? (selectedMailboxAvatarUrl ?? `/api/mailboxes/${selectedMailbox.id}/avatar`)
		: avatarUrl;
	// In All mailboxes every mailbox is one to switch to, the last selected one included.
	const otherMailboxes = mailboxes.filter((mailbox) => allMailboxes || mailbox.id !== selectedMailbox?.id);
	const adminActive = isAdminPath(pathname);

	async function logout() {
		const switched = await logoutClientSession();
		setOpen(false);
		router.replace(switched ? "/inbox" : "/login");
		router.refresh();
	}

	async function switchAccount(userId: string) {
		const error = await switchBrowserAccount(userId);
		setOpen(false);
		if (error) {
			router.push("/login?add=1");
			return;
		}
		router.replace("/inbox");
		router.refresh();
	}

	const inSidebar = placement === "sidebar";
	function toggleMenu() {
		if (!open) measure();
		setOpen((value) => !value);
	}

	return (
		<div ref={ref} className={inSidebar && !minimal ? "relative w-full" : "relative"}>
			<AccountTrigger
				open={open}
				onClick={toggleMenu}
				inSidebar={inSidebar}
				minimal={minimal}
				name={selectedName}
				email={selectedEmail}
				avatar={{
					name: selectedName,
					colorSeed: selectedEmail || selectedName,
					hasAvatar: selectedHasAvatar,
					avatarUrl: selectedAvatarUrl,
					onAvatarError: () => {
						if (!selectedMailbox) setHasAvatar(false);
					},
				}}
			/>

			{open && (
				<div
					data-placement={placement}
					// In the sidebar the menu is fixed to the window, so the sidebar's overflow cannot clip it, and
					// opens upward from the account at the bottom.
					style={
						anchor
							? ({ "--menu-bottom": `${anchor.bottom}px`, "--menu-max": `${anchor.maxHeight}px` } as CSSProperties)
							: undefined
					}
					className={`absolute right-0 top-14 z-90 data-[placement=sidebar]:fixed data-[placement=sidebar]:left-3 data-[placement=sidebar]:right-auto data-[placement=sidebar]:top-auto data-[placement=sidebar]:bottom-[var(--menu-bottom)] data-[placement=sidebar]:max-h-[var(--menu-max)] data-[placement=sidebar]:z-[200] w-[360px] overflow-hidden rounded-xl border border-neutral-200 bg-[#eef3fb] p-2 shadow-lg shadow-neutral-900/20 max-h-[82vh] overflow-y-auto`}
				>
					<div className="rounded-lg bg-white px-5 py-5">
						<div className="flex items-center gap-4">
							<AccountAvatar
								name={selectedName}
								colorSeed={selectedEmail || selectedName}
								hasAvatar={selectedHasAvatar}
								avatarUrl={selectedAvatarUrl}
								size="large"
								onAvatarError={() => {
									if (!selectedMailbox) setHasAvatar(false);
								}}
							/>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p className="truncate text-lg font-semibold text-neutral-900">{selectedName}</p>
									{selectedMailbox?.type === "shared" && (
										<Tooltip label="Shared inbox">
											<span title="Shared inbox" aria-label="Shared inbox" className="shrink-0 text-blue-600">
												<UsersRound className="h-4 w-4" />
											</span>
										</Tooltip>
									)}
								</div>
								<p className="truncate text-sm text-neutral-500">{selectedEmail}</p>
							</div>
							<Check className="h-5 w-5 shrink-0 text-blue-600" />
						</div>
						<Link
							href="/inbox"
							onClick={() => setOpen(false)}
							className="mt-4 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
						>
							<Inbox size={18} className="text-neutral-600" />
							Inbox
						</Link>
						<ModuleMenuLinks placement="mailbox-selector" onNavigate={() => setOpen(false)} />
						<ModuleMenuLinks placement="account-menu" onNavigate={() => setOpen(false)} />
						<Link
							href="/settings/account"
							onClick={() => setOpen(false)}
							className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
						>
							<Settings size={18} className="text-neutral-600" />
							Settings
						</Link>
						{otherMailboxes.length > 0 && (
							<div className="mt-3 border-t border-neutral-100 pt-2">
								<button
									type="button"
									onClick={() => setInboxesOpen((value) => !value)}
									aria-expanded={inboxesOpen}
									className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:bg-[#f2f6fc]"
								>
									Inboxes ({otherMailboxes.length})
									<ChevronDown size={16} className={`transition-transform ${inboxesOpen ? "rotate-180" : ""}`} />
								</button>
								{inboxesOpen &&
									otherMailboxes.map((mailbox) => {
										const mailboxCount = counts.mailboxes.find((count) => count.mailboxId === mailbox.id);
										return (
											<MailboxAccountRow
												key={mailbox.id}
												mailbox={mailbox}
												unread={mailboxCount?.unread ?? 0}
												avatarUrl={mailboxAvatarUrls[mailbox.id]}
												onSelect={() => {
													setSelectedMailbox(mailbox);
													setAllMailboxes(false);
													setOpen(false);
													router.push("/inbox");
												}}
											/>
										);
									})}
							</div>
						)}
						<ReadingLayoutMenu />
					</div>

					{otherAccounts.length > 0 && (
						<div className="mt-2 rounded-lg bg-white/55 p-1">
							<p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
								Other accounts
							</p>
							{otherAccounts.map((account) => (
								<button
									key={account.userId}
									type="button"
									onClick={() => void switchAccount(account.userId)}
									className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white"
								>
									<AccountAvatar
										name={account.name}
										colorSeed={account.email}
										hasAvatar={account.hasAvatar}
										avatarUrl={`/api/auth/accounts/${account.userId}/avatar`}
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-semibold text-neutral-900">{account.name}</p>
										<p className="truncate text-xs text-neutral-500">{account.email}</p>
									</div>
								</button>
							))}
						</div>
					)}

					<AccountMenuActions
						isAdmin={user?.role === "admin"}
						adminActive={adminActive}
						onNavigate={() => setOpen(false)}
						onLogout={logout}
					/>
				</div>
			)}
		</div>
	);
}
