export type CsrfRequestFacts = {
	authorization: string | null;
	fetchSite: string | null;
	origin: string | null;
	allowedHosts: string[];
};
