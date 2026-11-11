"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadEmailRequests, statusText, type EmailRequestSummary } from "./assistant-email-requests-utils";

/** Recent requests made to the assistant by email (spec §13, §14), with status and reason in plain words. */
export function AssistantEmailRequests() {
	const [requests, setRequests] = useState<EmailRequestSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		loadEmailRequests()
			.then((loaded) => active && setRequests(loaded))
			.catch((caught: unknown) => active && setError(caught instanceof Error ? caught.message : "Failed to load"));
		return () => {
			active = false;
		};
	}, []);

	if (error) return <p className="text-xs text-red-600">{error}</p>;
	if (!requests || requests.length === 0) return null;

	return (
		<div className="space-y-2 rounded-2xl border border-neutral-200 p-3">
			<p className="font-medium text-neutral-800">Recent requests by email</p>
			<ul className="space-y-1.5 text-xs">
				{requests.map((request) => (
					<li key={request.id} className="space-y-0.5">
						<p dir="auto" className="truncate font-medium text-neutral-700">
							{request.subject || "(no subject)"}
						</p>
						<p className="text-neutral-500">
							{statusText(request.status)}
							{request.reason ? ` — ${request.reason}` : ""}
							{request.conversationPath && (
								<>
									{" "}
									·{" "}
									<Link href={request.conversationPath} className="text-blue-700 underline-offset-2 hover:underline">
										Open
									</Link>
								</>
							)}
						</p>
					</li>
				))}
			</ul>
		</div>
	);
}
