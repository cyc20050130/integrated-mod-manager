import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cn } from "@/lib/utils"
function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "bg-muted text-muted-foreground gap-2 inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px] px-0",
        className
      )}
      {...props}
    />
  )
}
function TabsTrigger({
  className,nbg2=false,
  ...props
}: any) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "overflow-hidden data-[state=active]:text-background data-zzz:data-[state=active]:text-background  active:bg-accent/50 active:text-background data-zzz:active:text-background text-accent hover:brightness-120 text-ellipsis bg-button data-[state=active]:bg-accent   shadow-xs  duration-300 button-like data-zzz:border-border data-zzz:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring hover:border-accent/10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm data-zzz:text-xs font-medium whitespace-nowrap  focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
        nbg2?"":"bg2"
      )}
      {...props}
    />
  )
}
function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}
export { Tabs, TabsList, TabsTrigger, TabsContent }