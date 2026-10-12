"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const REFERRAL_CODE = "CKQHV8";
const REFERRAL_URL = `https://app.haimaker.ai/sign-up?ref=${REFERRAL_CODE}`;

export function HaimakerReferralCard() {
	const [copied, setCopied] = useState<"code" | "link" | null>(null);

	async function copy(value: string, kind: "code" | "link") {
		await navigator.clipboard.writeText(value);
		setCopied(kind);
	}

	return (
		<div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/70 p-4">
			<div>
				<p className="font-medium text-neutral-900">Refer &amp; Earn</p>
				<p className="mt-1 text-sm text-neutral-600">Give $50, get $20 with this referral.</p>
				<p className="mt-1 text-sm text-neutral-600">
					Browse Haimaker&apos;s live catalog, including DeepSeek, Qwen, GLM, Kimi and MiniMax when available.
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<code className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-semibold tracking-[0.2em]">
					{REFERRAL_CODE}
				</code>
				<Button type="button" variant="outline" size="sm" onClick={() => void copy(REFERRAL_CODE, "code")}>
					{copied === "code" ? "Copied" : "Copy code"}
				</Button>
				<Button type="button" size="sm" asChild>
					<a href={REFERRAL_URL} target="_blank" rel="noreferrer">
						<ExternalLink className="mr-2 h-4 w-4" />
						Sign up
					</a>
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={() => void copy(REFERRAL_URL, "link")}>
					{copied === "link" ? "Copied" : "Copy share link"}
				</Button>
			</div>
			<p className="break-all text-xs text-neutral-500">{REFERRAL_URL}</p>
		</div>
	);
}
