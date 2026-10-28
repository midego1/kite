import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
	{
		variants: {
			variant: {
				success: "border-transparent bg-green-600/10 text-green-800",
				default: "border-transparent bg-neutral-900 text-neutral-50",
				secondary: "border-transparent bg-neutral-100 text-neutral-900",
				outline: "border-neutral-200 bg-transparent text-neutral-700",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

export function Badge({
	className,
	variant,
	...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
	return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
