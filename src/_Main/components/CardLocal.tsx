import React from "react";
import { Label } from "@/components/ui/label";
import { getImageUrl, handleImageError, handleInAppLink } from "@/utils/utils";
import { Link2Icon, Link2OffIcon, SwordsIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openConflict } from "@/utils/vars";

interface CardLocalProps {
	item: {
		path: string;
		name: string;
		enabled: boolean;
		isDir: boolean;
		source?: string;
		crop?: {
			x?: number;
			y?: number;
			scale?: number;
			vertical?: boolean;
		};
	};
	selected: boolean;
	lastUpdated: number;
	hasUpdate: boolean;
	updateAvl: string;
	inConflict: number;
}

const CardLocal = React.memo(({ item, selected, lastUpdated, hasUpdate, updateAvl, inConflict }: CardLocalProps) => {
	const previewUrl = `${getImageUrl(item.path)}?${lastUpdated}`;
	return (
		<div
			className={`card-generic relative ${selected ? "selected-card" : ""}`}
			style={{
				borderColor: item.enabled ? "var(--accent)" : "",
			}}
		>
			<div className="relative w-full fadein h-[calc(100%-2.5rem)] flex items-center justify-center duration-200 rounded-t-lg data-gi:rounded-none pointer-events-none overflow-hidden">
				<img
					style={{
						filter: item.enabled ? "brightness(1)" : "brightness(0.5) saturate(0.5)",
						left: `${-(item.crop?.x || 0)}px`,
						top: `${-(item.crop?.y || 0)}px`,
						scale: item.crop?.scale || 1,
						minWidth: item.crop?.vertical ? "14rem" : "fit-content",
						minHeight: item.crop?.vertical ? "fit-content" : "18rem",
					}}
					className="w-full h-full relative object-cover object-center"
					src={previewUrl}
					loading="lazy"
					decoding="async"
					onError={(e) => handleImageError(e)}
				/>
			</div>
			<div
				className="bg-background/50 rounded-b-xl data-zzz:rounded-bl-3xl fadein backdrop-blur
			 flex items-center w-full min-h-10 gap-2 px-3 header-img"
			>
				{inConflict >= 0 ? (
					<Button
						onMouseDown={() => {
							openConflict(inConflict);
						}}
						variant="ghost"
						className="max-h-8 max-w-8 -ml-2 -mr-1"
					>
						<SwordsIcon className="text-destructive h-4" />
					</Button>
				) : item?.source ? (
					<Link2Icon className="text-accent h-4" />
				) : (
					<Link2OffIcon className="text-muted h-4" />
				)}
				<Label
					className="text-ellipsis w-56 overflow-hidden border-0 text-xs pointer-events-none select-none"
					style={{ backgroundColor: "#fff0", filter: item.enabled ? "brightness(1)" : "brightness(0.5) saturate(0.5)" }}
				>
					{item.name}
				</Label>
			</div>
			{item?.source && hasUpdate && (
				<div
					className="fadein backdrop-blur absolute top-0 left-0
			 flex items-center w-full h-8 bg-background/50 pointer-events-none duration-200 justify-center border-y header-img"
				>
					{" "}
					<div className="absolute h-full w-full bgx-flash pointer-events-none" />
					<div
						onMouseDown={() => {
							handleInAppLink(item.source || "");
						}}
						className="pointer-events-auto h-8 absolute  textx-flash w-full rounded-none text-xs hover:text-background flex items-center justify-center gap-1 cursor-pointer"
					>
						<UploadIcon className="h-4" /> {updateAvl}
					</div>
				</div>
			)}
		</div>
	);
});

CardLocal.displayName = "CardLocal";

export default CardLocal;
