import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
const buttonVariants = cva(
	"button-like data-zzz:text-foreground inline-flex  select-none items-center justify-center gap-2 active:scale-90 whitespace-nowrap rounded-md text-xs font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive ",
	{
		variants: {
			variant: {
				default:
					"overflow-hidden  active:bg-accent/50 active:text-background data-zzz:active:text-background text-accent hover:brightness-120 text-ellipsis bg-button shadow-xs  duration-300",
				destructive:
					"overflow-hidden  active:bg-destructive/50 active:text-background data-zzz:active:text-background text-accent hover:brightness-120 text-ellipsis bg-button shadow-xs  duration-300 text-destructive hover:bg-destructive data-zzz:text-destructive hover:text-background",
				warn: "overflow-hidden  active:bg-warn/50 active:text-background data-zzz:active:text-background text-accent hover:brightness-120 text-ellipsis bg-button shadow-xs  duration-300 text-warn hover:bg-accent data-zzz:text-warn hover:text-background",
				success:
					"overflow-hidden  active:bg-success/50 active:text-background data-zzz:active:text-background text-accent hover:brightness-120 text-ellipsis bg-button shadow-xs  duration-300 text-success hover:bg-accent data-zzz:text-success hover:text-background",
				outline:
					"border bg-background shadow-xs hover:bg-accent data-zzz:hover:bgaccent   hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
				secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
				ghost: "hover:bg-accent  hover:text-accent-foreground dark:hover:bg-accent/30  ",
				hidden: "",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-10 px-4 py-2 has-[>svg]:px-3",
				sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
				lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
				icon: "size-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);
function Button({
	className,
	variant,
	size,
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot : "button";
	return (
		<Comp
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }), " cursor-pointerx")}
			{...props}
		/>
	);
}
export { Button, buttonVariants };
