"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CopyCodeHostState } from "./copy-code-host-types";
import {
	COPY_CODE_REQUEST_EVENT,
	type CopyCodeChannelMessage,
	type CopyCodeRequest,
	writeCodeToClipboard,
} from "./copy-code-host-utils";

function CopyCodeDialog({ code, onClose }: { code: string; onClose: () => void }) {
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-h-[calc(100vh-4rem)]">
				<DialogHeader>
					<DialogTitle>One-time code</DialogTitle>
					<DialogDescription>
						Your browser did not allow Kite to copy it automatically. Select it, or press the button.
					</DialogDescription>
				</DialogHeader>
				<p className="rounded-xl bg-neutral-100 px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.3em] text-neutral-900 select-all">
					{code}
				</p>
				<div className="mt-5 flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={onClose}>
						Close
					</Button>
					<Button
						type="button"
						disabled={busy}
						onClick={() => {
							setBusy(true);
							void writeCodeToClipboard(code).then((copied) => {
								setBusy(false);
								if (copied) {
									toast.success("Code copied");
									onClose();
								}
							});
						}}
					>
						Copy code
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Handles copy-code requests from the popup, the reader and notification clicks; mount once near the root. */
export function CopyCodeHost() {
	const router = useRouter();
	const [state, setState] = useState<CopyCodeHostState>({ pendingCode: null });

	useEffect(() => {
		const copy = async (code: string) => {
			if (await writeCodeToClipboard(code)) {
				toast.success("Code copied");
				setState((current) => ({ ...current, pendingCode: null }));
			} else {
				setState((current) => ({ ...current, pendingCode: code }));
			}
		};
		const onWindowRequest = (event: Event) => {
			const detail = (event as CustomEvent<CopyCodeRequest>).detail;
			if (typeof detail?.code === "string" && detail.code) void copy(detail.code);
		};
		const onServiceWorkerMessage = (event: MessageEvent<CopyCodeChannelMessage>) => {
			const data = event.data;
			if (data?.type === "kite:copy-code" && typeof data.code === "string" && data.code) void copy(data.code);
			else if (data?.type === "kite:open-message" && typeof data.messageId === "string" && data.messageId) {
				router.push(`/inbox/${encodeURIComponent(data.messageId)}`);
			}
		};
		window.addEventListener(COPY_CODE_REQUEST_EVENT, onWindowRequest);
		navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
		return () => {
			window.removeEventListener(COPY_CODE_REQUEST_EVENT, onWindowRequest);
			navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
		};
	}, [router]);

	return state.pendingCode ? (
		<CopyCodeDialog
			code={state.pendingCode}
			onClose={() => setState((current) => ({ ...current, pendingCode: null }))}
		/>
	) : null;
}
