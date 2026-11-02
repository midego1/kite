"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The README's "Deploy with an AI coding agent" prompt, copied verbatim, including the token-handling lines.
 * Do not reword it here; change the README first and then this constant.
 */
export const DEPLOY_PROMPT = `Install Kite from https://github.com/midego1/kite in my Cloudflare account.
Ask me for my Cloudflare account ID, a scoped deployment API token, and a separate
runtime CF_TOKEN through a secret input. Generate a long random SETUP_TOKEN and
APP_ENCRYPTION_KEY. Never print, commit, or place these secrets in a command
argument or a tracked file. Use the deployment token only for Wrangler
authentication (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).

Read README.md, docs/deployment.md, and wrangler.jsonc first. Keep the Worker name
exactly kite. In the selected account, create or reuse the D1 database kite,
R2 bucket kite-raw, and Queues kite-inbound, kite-outbound, and kite-agent.
Set the D1 database_id in the local Wrangler config without committing that
account-specific ID. Install dependencies,
run npm run deploy, and set CF_TOKEN, SETUP_TOKEN, and APP_ENCRYPTION_KEY as Worker
secrets. Then give me SETUP_TOKEN and a copy of APP_ENCRYPTION_KEY to keep safe:
I need the token to open /setup, and losing the key makes the provider keys Kite
stores unreadable. Do not run remote D1 migrations manually; the /setup flow
initializes the database.

Give me the deployed URL and any remaining Cloudflare account actions. I will
open /setup, create the first admin account, and connect my domain there.`;

/** The prompt, with a button that copies it. Tokens are never in the prompt: the agent has to ask for them. */
export function HomeDeployPrompt() {
	const [copied, setCopied] = useState(false);
	const preRef = useRef<HTMLPreElement>(null);

	// Without the clipboard API (plain http, as a Docker install is served) or its permission, select the prompt
	// shown in the pre instead; where execCommand still works that selection is copied, else it stays selected.
	const selectPrompt = () => {
		const pre = preRef.current;
		if (!pre) return;
		const range = document.createRange();
		range.selectNodeContents(pre);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		setCopied(document.execCommand("copy"));
	};

	const copyPrompt = () => {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			void navigator.clipboard.writeText(DEPLOY_PROMPT).then(() => setCopied(true), selectPrompt);
			return;
		}
		selectPrompt();
	};

	return (
		<div className="mt-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-xl text-sm leading-6 text-neutral-600">
					Give the agent your Cloudflare account ID and two separate scoped API tokens through its secret input. Never
					put them in a public chat, a repository or a committed file.
				</p>
				<Button type="button" variant="outline" className="bg-white" onClick={copyPrompt}>
					{copied ? "Copied" : "Copy prompt"}
				</Button>
			</div>
			<pre
				ref={preRef}
				className="mt-4 max-w-full overflow-x-auto whitespace-pre-wrap rounded-xl bg-[#f6f8fc] p-4 text-left font-mono text-xs leading-5 text-neutral-800"
			>
				{DEPLOY_PROMPT}
			</pre>
		</div>
	);
}
