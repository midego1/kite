import { cn } from "@/lib/utils";

export type ComposeToastState = { type: "success" | "error"; message: string } | null;

export function ComposeToast({ toast }: { toast: ComposeToastState }) {
	if (!toast) return null;
	return (
		<div
			className={cn(
				"fixed right-6 top-6 z-[60] rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
				toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white",
			)}
		>
			{toast.message}
		</div>
	);
}
