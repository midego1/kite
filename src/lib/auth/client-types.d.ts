export type AuthFetchOptions = RequestInit & {
	redirectOnUnauthorized?: boolean;
};

export type AuthSessionResponse = {
	ok?: boolean;
	userId?: string;
	redirect?: string;
	error?: string;
};

export type AuthSessionChangedDetail = {
	authenticated: boolean;
};
