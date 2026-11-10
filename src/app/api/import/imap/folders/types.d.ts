export type ImapFolderListRequest = {
	host?: string;
	port?: number;
	secure?: boolean;
	username?: string;
	password?: string;
	/** Set by `resolveImportSource` for a connected OAuth account, never by the form. */
	accessToken?: string;
};
