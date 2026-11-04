import type { TooltipProps } from "./tooltip-types";

// "auto" sits below the trigger and flips above it when the viewport has no room (Radix collision handling).
// "right" is beside a sidebar rail, away from the screen edge, so it is the left side in a right-to-left interface.
export function tooltipSide(
	placement: TooltipProps["placement"] = "auto",
	direction: "ltr" | "rtl" = "ltr",
): "bottom" | "right" | "left" {
	if (placement !== "right") return "bottom";
	return direction === "rtl" ? "left" : "right";
}
