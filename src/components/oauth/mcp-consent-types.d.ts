export type McpConsentDetails = {
	client: { name: string; redirectHost: string };
	scopes: string[];
	checked: string[];
	mailboxes: { id: string; address: string }[];
};

/**
 * What loading the request gave: the screen, a message to show, or a message with the client's URL that tells it
 * why, which the user follows by hand.
 */
export type McpConsentLoad =
	| { kind: "details"; details: McpConsentDetails }
	| { kind: "error"; message: string }
	| { kind: "redirect"; url: string; message: string; host: string };
