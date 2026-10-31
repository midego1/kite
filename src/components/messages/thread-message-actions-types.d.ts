import type { ThreadMessage } from "@/hooks/types";

export type ThreadMessageActionsProps = {
	message: ThreadMessage;
	mailboxId: string | null;
	ownAddress?: string | null;
	ownAddresses?: string[];
	starOnly?: boolean;
	/** The reader showed this message's remote images, so Print shows them too. */
	remoteImagesShown?: boolean;
};
