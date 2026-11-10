export type ImapImportInput = {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	/** A connected OAuth account's access token (spec §15.4): the sign-in uses XOAUTH2 and `password` is empty. */
	accessToken?: string;
	folder: string;
	limit: number;
	/** Number of newest messages already imported by earlier batches. */
	offset: number;
};
