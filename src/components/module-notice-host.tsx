"use client";

import Link from "next/link";
import { useEffect } from "react";
import toast from "react-hot-toast";
import type { ModuleNoticeEvent } from "@/hooks/message-realtime-types";
import { MODULE_NOTICE_EVENT } from "@/hooks/message-realtime-utils";

const MODULE_NOTICE_DURATION_MS = 10_000;

function showModuleNoticeToast(notice: ModuleNoticeEvent) {
	toast(
		(current) => (
			<span className="flex items-center gap-4 text-sm">
				<span className="min-w-0">
					<span className="block font-medium">{notice.title}</span>
					{notice.body && <span className="block text-neutral-500">{notice.body}</span>}
				</span>
				{notice.href && (
					<Link
						href={notice.href}
						onClick={() => toast.dismiss(current.id)}
						className="shrink-0 rounded-md px-2 py-1 font-semibold text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
					>
						Open
					</Link>
				)}
			</span>
		),
		{
			id: `module-notice:${notice.moduleId}:${notice.notice}:${notice.href ?? notice.title}`,
			duration: MODULE_NOTICE_DURATION_MS,
			ariaProps: { role: "status", "aria-live": "polite" },
		},
	);
}

/** Shows every module notice that reaches this tab as a toast with an Open link. */
export function ModuleNoticeHost() {
	useEffect(() => {
		function onNotice(event: Event) {
			const notice = (event as CustomEvent<ModuleNoticeEvent>).detail;
			if (notice?.title) showModuleNoticeToast(notice);
		}
		window.addEventListener(MODULE_NOTICE_EVENT, onNotice);
		return () => window.removeEventListener(MODULE_NOTICE_EVENT, onNotice);
	}, []);
	return null;
}
