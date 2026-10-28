import { TOAST_CORNER_CLASS, TOAST_SURFACE_CLASS } from "@/components/ui/toast-styles";
import { cn } from "@/lib/utils";

export type ComposeToastState = { type: "success" | "error"; message: string } | null;

export function ComposeToast({ toast }: { toast: ComposeToastState }) {
	if (!toast) return null;
	return (
		<div
			role={toast.type === "error" ? "alert" : "status"}
			className={cn(
				TOAST_CORNER_CLASS,
				TOAST_SURFACE_CLASS,
				"z-[60] font-medium",
				toast.type === "success" ? "border-green-600" : "border-red-600",
			)}
		>
			{toast.message}
		</div>
	);
}
