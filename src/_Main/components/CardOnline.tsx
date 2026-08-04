import React, { useState } from "react";
import { EyeOffIcon, LoaderIcon, MessageSquareIcon, PlusIcon, ThumbsUpIcon, TriangleAlertIcon } from "lucide-react";
import { getTimeDifference } from "@/utils/utils";
import { Button } from "@/components/ui/button";
import { RemoteImage } from "@/components/RemoteImage";
import { GameBananaModPreview } from "@/components/GameBananaModPreview";
import { normalizeGameBananaPreviewMedia } from "@/utils/gameBananaPreview";

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
	isInstalled?: boolean;
	hasUpdate?: boolean;
	isBlacklisted?: boolean;
	installedLabel?: string;
	updateLabel?: string;
	blacklistedLabel?: string;
}

const statusBadgeClass =
	"rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none backdrop-blur bg-background/70";

const Online = React.memo((data: CardOnlineProps) => {
	const [revealed, setRevealed] = useState(false);
	const preview = normalizeGameBananaPreviewMedia(data._aPreviewMedia);
	const rawBackgroundImage = data._aPreviewMedia?._aImages?.[0]
		? `${data._aPreviewMedia._aImages[0]._sBaseUrl}/${data._aPreviewMedia._aImages[0]._sFile}`
		: "";
	const backgroundImage =
		data._sModelName === "Mod" ? (preview.kind === "ready" ? preview.url : "") : rawBackgroundImage;
	const needsBlur = data._sInitialVisibility === "hide" && data.blur === true && !revealed;

	return (
		<div className="card-generic card-online">
			<div className="relative min-h-full overflow-hidden rounded-t-lg data-gi:rounded-none">
				{data._sModelName === "Mod" ? (
					<GameBananaModPreview
						className="fadein flex min-h-full w-full items-center justify-center object-cover duration-200 pointer-events-none"
						source={backgroundImage}
						resolution={preview}
						loading="lazy"
						decoding="async"
						style={{
							filter: needsBlur ? "brightness(0.5) blur(4px)" : "brightness(1)",
						}}
					/>
				) : (
					<RemoteImage
						className="fadein flex min-h-full w-full items-center justify-center object-cover duration-200 pointer-events-none"
						src={backgroundImage}
						fallbackSrc="/who.jpg"
						loading="lazy"
						decoding="async"
						style={{
							filter: needsBlur ? "brightness(0.5) blur(4px)" : "brightness(1)",
						}}
					/>
				)}
				<div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
					<div className="max-w-[6.5rem] rounded-md bg-background/60 px-2 py-1 text-xs text-accent backdrop-blur">
						{data._sModelName}
					</div>
					<div className="flex max-w-[8.5rem] flex-col items-end gap-1 text-right">
						{data.isBlacklisted && (
							<div className={`${statusBadgeClass} border-destructive/50 text-destructive`}>
								<TriangleAlertIcon className="mr-1 inline h-3 w-3" />
								{data.blacklistedLabel}
							</div>
						)}
						{data.hasUpdate ? (
							<div className={`${statusBadgeClass} border-amber-400/40 text-amber-200`}>{data.updateLabel}</div>
						) : data.isInstalled ? (
							<div className={`${statusBadgeClass} border-accent/40 text-accent`}>{data.installedLabel}</div>
						) : null}
					</div>
				</div>
			</div>
			{needsBlur && (
				<div className="max-h-0 fadein mb-41 -mt-41 w-fit z-20 self-center">
					<Button
						className="bg-background/50 duration-200 pointer-events-auto"
						onClick={() => {
							setRevealed(true);
						}}
					>
						<EyeOffIcon /> {data.show}
					</Button>
				</div>
			)}

			<div className="bg-background/50 fadein backdrop-blur flex flex-col w-full gap-2 px-4 py-2">
				<div className="min-h-9 max-h-9 overflow-hidden text-sm leading-4 break-words">{data._sName}</div>
				<div className="flex justify-between w-full h-6 text-xs gap-2">
					<label className="flex items-center justify-center min-w-0 gap-1">
						<PlusIcon className="h-4 min-w-4" />
						<span className="truncate">{getTimeDifference(data.now, data._tsDateAdded || 0)}</span>
					</label>
					<label className="flex items-center justify-center min-w-0 gap-1">
						<LoaderIcon className="h-4 min-w-4" />
						<span className="truncate">{getTimeDifference(data.now, data._tsDateModified || 0)}</span>
					</label>
					<label className="flex items-center justify-center min-w-0 gap-1">
						<ThumbsUpIcon className="h-4 min-w-4" />
						<span className="truncate">{data._nLikeCount || "0"}</span>
					</label>
					<label className="flex items-center justify-center min-w-0 gap-1">
						<MessageSquareIcon className="h-4 min-w-4" />
						<span className="truncate">{data._nPostCount || "0"}</span>
					</label>
				</div>
			</div>
		</div>
	);
});

Online.displayName = "CardOnline";

export default Online;
