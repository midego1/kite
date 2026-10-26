import { messageShortcuts } from "@/components/message-actions/message-shortcuts";
import { readerNavigationShortcuts } from "@/components/messages/message-detail-navigation-utils";
import { listShortcuts } from "@/components/messages/message-list-keyboard-utils";
import type { ShortcutDefinition, ShortcutHint } from "./types";

const noop = () => undefined;

function hint({ key, label, category, modifiers }: ShortcutDefinition): ShortcutHint {
	return { key, label, category, modifiers };
}

/**
 * The mail keys, read from the bindings the message list (`use-message-list-keyboard.ts`) and the reader
 * (`message-shortcuts.ts`, `message-detail-navigation.tsx`) make while they are on screen.
 */
function mailKeyHints(): ShortcutHint[] {
	const bindings = [
		...listShortcuts({ next: noop, previous: noop, open: noop, select: noop, archive: noop, trash: noop }),
		...readerNavigationShortcuts(noop),
		...messageShortcuts({
			status: "received",
			direction: "inbound",
			runAction: noop,
			handleReply: noop,
			forward: noop,
			canReplyAll: true,
			back: noop,
		}),
	];
	const seen = new Set<string>();
	return bindings.map(hint).filter((item) => {
		const id = `${item.key}\u0000${item.label}`;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

/** The provider's bindings followed by the mail keys, without a key and label the provider already lists. */
export function withMailKeyHints(bindings: ShortcutHint[]): ShortcutHint[] {
	const listed = new Set(bindings.map((binding) => `${binding.key.toLowerCase()}\u0000${binding.label}`));
	return [...bindings, ...mailKeyHints().filter((item) => !listed.has(`${item.key}\u0000${item.label}`))];
}
