export type FolderMoveTarget = "inbox" | "archive";

/** What deleting a folder touches, shown in the confirm dialog before anything changes. */
export type FolderUsage = {
	messageCount: number;
	/** Enabled and disabled inbox rules that file mail into the folder; deleting turns them off. */
	ruleCount: number;
	/** Import jobs still filing mail into the folder; deleting is refused while there are any. */
	activeImports: number;
};

export type FolderDeleteResult = {
	messagesMoved: number;
	rulesDisabled: number;
};
