"use client";

import React, { useCallback, useId, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { handOffMailSearch, useOptionalMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { formatMessageListTimestamp } from "@/components/messages/utils";
import { resolveNavIcon } from "@/components/modules/client-registry";
import { useModules } from "@/components/modules/modules-context";
import { searchNavAcrossModes } from "@/components/settings/section-nav-utils";
import { useReturnFocus } from "@/components/ui/use-return-focus";
import { useCurrentUser } from "@/hooks/use-current-user";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { CommandParamForm } from "./command-palette-params";
import { filterCommands } from "./command-palette-utils";
import { PaletteFooter, PaletteResults, optionId } from "./palette-results";
import { PaletteSidebar, categoryTabId } from "./palette-sidebar";
import type { PaletteCategoryId, PaletteItem, PaletteRemoteResults } from "./palette-types";
import {
	categoryForDigit,
	clampActive,
	commandHrefs,
	commandItems,
	contactItem,
	countItems,
	digitOf,
	groupItems,
	isTypingKey,
	listCategories,
	messageItem,
	moveActive,
	sectionItems,
	settingsItems,
} from "./palette-utils";
import { usePaletteSearch } from "./use-palette-search";
import type { CommandItem } from "./types";

interface CommandPaletteProps {
	isOpen: boolean;
	onClose: () => void;
	commands: CommandItem[];
}

export const PALETTE_PLACEHOLDER = "Search mail, contacts, pages…";

type Navigate = (href: string) => void;

/** Every row for the query: the commands, the Settings pages the user may open, then what the searches answered. */
function usePaletteItems(
	commands: CommandItem[],
	query: string,
	remote: PaletteRemoteResults,
	navigate: Navigate,
	openContact: (email: string) => void,
): PaletteItem[] {
	const user = useCurrentUser();
	const { modules } = useModules();
	return useMemo(() => {
		const matching = filterCommands(commands, query);
		const settings = settingsItems(
			searchNavAcrossModes(query, user, "settings", modules),
			commandHrefs(commands),
			navigate,
		);
		const messages = (remote.messages?.items ?? []).map((row) =>
			messageItem(row, navigate, formatMessageListTimestamp),
		);
		const contacts = (remote.contacts?.items ?? []).map((row) => contactItem(row, openContact));
		const records = remote.sections.flatMap((section) => {
			const source = CLIENT_MODULES.find((entry) => entry.id === section.moduleId);
			return sectionItems(section, source ? resolveNavIcon(source.nav[0]?.icon ?? "") : undefined, navigate);
		});
		return [...commandItems(matching), ...settings, ...messages, ...contacts, ...records];
	}, [commands, query, user, modules, remote, navigate, openContact]);
}

/**
 * Cmd+K: a floating search box over a two-column panel. The left column lists the categories (Pages,
 * Messages, Contacts, Actions, Settings and the modules that are on) with a number key and a count each;
 * the right lists the matching rows under their headings. Commands come from core and the enabled
 * modules; mail, contacts and module records are searched as the user types. A command with parameters
 * asks for them before it runs.
 */
function CommandPaletteDialog({ onClose, commands }: { onClose: () => void; commands: CommandItem[] }) {
	const router = useRouter();
	const { modules } = useModules();
	const { mailboxScope } = useSelectedMailbox();
	const mailSearch = useOptionalMailSearch();
	const returnFocus = useReturnFocus();
	const inputRef = useRef<HTMLInputElement>(null);
	const listboxId = useId();
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<PaletteCategoryId>("all");
	const [active, setActive] = useState(0);
	const [pending, setPending] = useState<PaletteItem | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [paramError, setParamError] = useState<string | null>(null);

	const navigate = useCallback<Navigate>((href) => router.push(href), [router]);
	const openContact = useCallback(
		(email: string) => {
			const search = `from:${email}`;
			// The inbox may mount a fresh mail search (from Settings, or from the calendar's own); it reads the note.
			handOffMailSearch(search);
			mailSearch?.setQuery(search);
			router.push(`/inbox?q=${encodeURIComponent(search)}`);
		},
		[mailSearch, router],
	);

	const remote = usePaletteSearch(query, mailboxScope);
	const items = usePaletteItems(commands, query.trim(), remote, navigate, openContact);
	const categories = useMemo(
		() => listCategories(CLIENT_MODULES, modules, commands, resolveNavIcon),
		[modules, commands],
	);
	const counts = useMemo(
		() => countItems(items, categories, { messages: remote.messages?.total, contacts: remote.contacts?.total }),
		[items, categories, remote.messages?.total, remote.contacts?.total],
	);
	const groups = useMemo(() => groupItems(items, categories, category), [items, categories, category]);
	const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
	const activeIndex = clampActive(active, flat.length);
	const activeItem = activeIndex >= 0 ? flat[activeIndex] : undefined;

	const select = (item: PaletteItem) => {
		if (item.params?.length) {
			setPending(item);
			setValues({});
			setParamError(null);
			return;
		}
		const result = item.perform();
		onClose();
		void Promise.resolve(result).then((message) => {
			if (typeof message === "string") toast.error(message);
		});
	};

	const submitParams = async () => {
		if (!pending) return;
		const entered = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ""));
		const message = await pending.perform(entered);
		if (typeof message === "string") setParamError(message);
		else onClose();
	};

	const chooseCategory = (id: PaletteCategoryId) => {
		setCategory(id);
		setActive(0);
	};

	// One handler for the whole dialog: the arrow keys and Enter work from the search box, the sidebar and
	// the list alike; a digit (with Alt anywhere, bare outside the box) picks a category; a character typed
	// elsewhere lands in the box. Handled keys stop here so the page's own shortcuts never see them.
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.defaultPrevented) return;
		const input = inputRef.current;
		const inInput = event.target === input;
		if (pending) {
			if (event.key === "Enter") {
				event.preventDefault();
				void submitParams();
			}
			return;
		}
		const digit = digitOf(event);
		if (digit !== null && (event.altKey || !inInput)) {
			const next = categoryForDigit(categories, digit);
			if (next) {
				event.preventDefault();
				event.stopPropagation();
				chooseCategory(next);
				// From the sidebar the focus follows the chosen tab, as the arrow keys would have moved it.
				if (event.target instanceof HTMLElement && event.target.getAttribute("role") === "tab")
					document.getElementById(categoryTabId(listboxId, next))?.focus();
				return;
			}
		}
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			setActive(moveActive(activeIndex, flat.length, event.key));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			if (activeItem) select(activeItem);
			return;
		}
		if (!inInput && isTypingKey(event) && input) {
			event.stopPropagation();
			input.focus();
		}
	};

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/40 backdrop-blur-xs" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					{...returnFocus}
					onEscapeKeyDown={(event) => {
						// Escape leaves the parameter form for the list before it closes the palette.
						if (!pending) return;
						event.preventDefault();
						setPending(null);
					}}
					onKeyDown={onKeyDown}
					data-testid="command-palette"
					className="dialog-content fixed inset-0 z-50 flex flex-col focus:outline-none md:inset-auto md:left-1/2 md:top-[10vh] md:w-[min(60rem,calc(100vw-2rem))] md:-translate-x-1/2 md:gap-3"
				>
					<DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
					<div className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4 md:rounded-full md:border md:px-5 md:shadow-2xl">
						<Search className="h-5 w-5 shrink-0 text-neutral-400" aria-hidden="true" />
						<input
							ref={inputRef}
							type="text"
							role="combobox"
							aria-label="Search commands"
							aria-expanded="true"
							aria-controls={listboxId}
							aria-autocomplete="list"
							aria-activedescendant={!pending && activeIndex >= 0 ? optionId(listboxId, activeIndex) : undefined}
							autoComplete="off"
							spellCheck={false}
							value={query}
							disabled={pending !== null}
							onChange={(event) => {
								// A new query starts from the first row again.
								setQuery(event.target.value);
								setActive(0);
							}}
							placeholder={PALETTE_PLACEHOLDER}
							className="w-full bg-transparent text-[15px] text-neutral-900 placeholder-neutral-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
						/>
						{remote.loading && (
							<Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" aria-hidden="true" />
						)}
						<button
							type="button"
							aria-label={query ? "Clear search" : "Close"}
							onClick={() => {
								if (query) {
									setQuery("");
									inputRef.current?.focus();
								} else onClose();
							}}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
						>
							<X className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white md:flex-initial md:rounded-2xl md:border md:border-neutral-200 md:shadow-2xl">
						<div className="flex min-h-0 flex-1 flex-col md:flex-row">
							<PaletteSidebar
								categories={categories}
								counts={counts}
								active={category}
								panelId={listboxId}
								onSelect={chooseCategory}
							/>
							{pending ? (
								<div className="min-h-0 flex-1 overflow-y-auto">
									<CommandParamForm
										item={pending}
										values={values}
										error={paramError}
										onChange={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
									/>
								</div>
							) : (
								<PaletteResults
									groups={groups}
									listboxId={listboxId}
									activeIndex={activeIndex}
									query={query.trim()}
									category={category}
									loading={remote.loading}
									onActivate={setActive}
									onSelect={select}
								/>
							)}
						</div>
						<PaletteFooter />
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
	if (!isOpen) return null;
	return <CommandPaletteDialog onClose={onClose} commands={commands} />;
}
