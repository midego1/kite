import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { ERROR_FILL_CLASS, ERROR_TEXT_CLASS, WARNING_FILL_CLASS, WARNING_TEXT_CLASS } from "@/components/notice-styles";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("rounded-xl border border-neutral-200 bg-white p-5", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
	return <h3 className={cn("text-base font-semibold leading-none", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
	return <p className={cn("text-sm text-neutral-500", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("pt-4", className)} {...props} />;
}

const CARD_ICON_TONE = {
	/** The accent's faintest tint with the accent itself, as each style remaps them. */
	neutral: "bg-blue-50 text-blue-600",
	warning: `${WARNING_FILL_CLASS} ${WARNING_TEXT_CLASS}`,
	critical: `${ERROR_FILL_CLASS} ${ERROR_TEXT_CLASS}`,
} as const;

/**
 * The icon before a card's title: a small rounded square in the accent's faintest tint, as the command center's
 * cards and the admin overview's cards draw it; amber or red when the card is a warning.
 */
export function CardIcon({
	icon: Icon,
	tone = "neutral",
	className,
}: {
	icon: LucideIcon;
	tone?: keyof typeof CARD_ICON_TONE;
	className?: string;
}) {
	return (
		<span
			className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", CARD_ICON_TONE[tone], className)}
		>
			<Icon className="h-4 w-4" aria-hidden="true" />
		</span>
	);
}

/** A card's title row: the icon, the title and the line under it, and whatever sits at the right. */
export function CardTitleRow({
	icon,
	tone,
	title,
	description,
	action,
	className,
}: {
	icon?: LucideIcon;
	tone?: keyof typeof CARD_ICON_TONE;
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<CardHeader className={cn("flex-row items-start gap-3", className)}>
			{icon && <CardIcon icon={icon} tone={tone} className="mt-px" />}
			<div className="min-w-0 flex-1">
				<CardTitle className="text-sm leading-7">{title}</CardTitle>
				{description && <CardDescription className="mt-0.5">{description}</CardDescription>}
			</div>
			{action && <div className="flex shrink-0 items-center self-center">{action}</div>}
		</CardHeader>
	);
}
