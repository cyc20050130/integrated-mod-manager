import React, { useState } from "react";
import { EyeOffIcon, LoaderIcon, MessageSquareIcon, PlusIcon, ThumbsUpIcon } from "lucide-react";
import { getTimeDifference, handleImageError } from "@/utils/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
// import { CSS_CLASSES, COMMON_STYLES } from "@/utils/consts";
// import type { CardLocalProps } from "@/utils/types";

interface CardOnlineProps {
	_sName: string;
	_sModelName: string;
	_sInitialVisibility: string;
	_nLikeCount: number;
	_nPostCount?: number;
	_tsDateAdded?: number;
	_tsDateModified?: number;
	_aPreviewMedia?: {
		_aImages?: {
			_sBaseUrl: string;
			_sFile: string;
		}[];
	};
	blur?: boolean;
	now: number;
	show: string;
}

const Online = React.memo((data: CardOnlineProps) => {
	const [revealed, setRevealed] = useState(false);
	const backgroundImage = data._aPreviewMedia?._aImages?.[0]
		? `${data._aPreviewMedia._aImages[0]._sBaseUrl}/${data._aPreviewMedia._aImages[0]._sFile}`
		: "/err";
	const needsBlur = data._sInitialVisibility === "hide" && data.blur === true && !revealed;

	return (
		<div className="card-generic card-online ">
			<div className="relative min-h-full overflow-hidden rounded-t-lg data-gi:rounded-none">
				<img
					className="fadein flex min-h-full w-full items-center justify-center object-cover duration-200 pointer-events-none"
					src={backgroundImage}
					loading="lazy"
					decoding="async"
					onError={(e) => handleImageError(e, true)}
					style={{
						filter: needsBlur ? "brightness(0.5) blur(4px)" : "brightness(1)",
					}}
				/>
			</div>
			{needsBlur && (
				<div className="max-h-0 fadein mb-41 -mt-41 w-fit z-20 self-center">
					<Button
						className=" bg-background/50 duration-200 pointer-events-auto"
						onClick={() => {
							setRevealed(true);
						}}
					>
						<EyeOffIcon /> {data.show}
					</Button>
				</div>
			)}
			<div
				className={`w-fit fadein bg-background/50 text-accent  backdrop-blur -mt-68 flex flex-col items-center px-4 py-1 mb-44 rounded-br-lg pointer-events-none`}
			>
				{data._sModelName}
			</div>

			<div className={`bg-background/50 fadein backdrop-blur flex flex-col items-center w-full px-4 py-1`}>
				<Input
					readOnly
					type="text"
					className="bg-semi w-56 cursor-pointerx select-none focus-within:select-auto overflow-hidden h-8 focus-visible:ring-[0px] border-0 text-ellipsis"
					defaultValue={data._sName}
				/>
				<div className="flex justify-between w-full h-6 text-xs">
					<label className="flex items-center justify-center">
						<PlusIcon className="h-4" />
						{getTimeDifference(data.now, data._tsDateAdded || 0)}
					</label>
					<label className="flex items-center justify-center">
						<LoaderIcon className="h-4" />
						{getTimeDifference(data.now, data._tsDateModified || 0)}
					</label>
					<label className="flex items-center justify-center">
						<ThumbsUpIcon className="h-4" />
						{data._nLikeCount || "0"}
					</label>
					<label className="flex items-center justify-center">
						<MessageSquareIcon className="h-4" />
						{data._nPostCount || "0"}
					</label>
				</div>
			</div>
		</div>
	);
});

Online.displayName = "CardOnline";

export default Online;
