import { useEffect, useMemo, useState } from "react";
import { Carousel as CarouselCN, CarouselContent, CarouselItem } from "@/components/ui/carousel";
// import { OnlineModImage } from "@/utils/types";
import type { EmblaCarouselType } from "embla-carousel";
import { RemoteImage } from "@/components/RemoteImage";
import { GameBananaModPreview } from "@/components/GameBananaModPreview";
import { normalizeGameBananaImage } from "@/utils/gameBananaPreview";
import type { OnlineModImage } from "@/utils/types";

type PreviewImageLike = OnlineModImage;

function Carousel({ data, big, modOnly = false }: { data: PreviewImageLike[]; big?: boolean; modOnly?: boolean }) {
	big = big || false;
	const w = big ? "45rem" : "12.5rem";
	const previews = useMemo(() => {
		const seen = new Set<string>();
		if (!modOnly)
			return data.map((item) => ({ item, preview: null as ReturnType<typeof normalizeGameBananaImage> | null }));
		return data.flatMap((item) => {
			const preview = normalizeGameBananaImage(item);
			if (preview.kind === "ready") {
				if (seen.has(preview.url)) return [];
				seen.add(preview.url);
			}
			return [{ item, preview }];
		});
	}, [data, modOnly]);
	const [current, setCurrent] = useState(0);
	const [api, setApi] = useState<EmblaCarouselType | undefined>();
	useEffect(() => {
		if (!api) return;
		const onSelect = () => {
			setCurrent(api.selectedScrollSnap());
		};
		api.on("select", onSelect);
		return () => {
			api.off("select", onSelect);
		};
	}, [api]);
	useEffect(() => {
		setCurrent(0);
		api?.scrollTo(0);
	}, [api, previews]);
	return (
		<>
			<CarouselCN
				setApi={setApi}
				opts={{ loop: true }}
				className="aspect-video min-w-full max-w-full min-h-[calc(100%-4rem)] overflow-hidden rounded-lg"
			>
				<CarouselContent className="aspect-video min-w-full min-h-full">
					{previews.map(({ item, preview }, index) => (
						<CarouselItem
							key={preview?.kind === "ready" ? preview.url : `${preview?.kind || "raw"}:${index}`}
							className="flex flex-col overflow-hidden"
						>
							<div className="flex aspect-video flex-col overflow-hidden rounded-lg border bg-black/20">
								{modOnly ? (
									<GameBananaModPreview
										className="h-full w-full object-contain"
										source={preview?.kind === "ready" ? preview.url : ""}
										{...(preview ? { resolution: preview } : {})}
										loading={index === 0 ? "eager" : "lazy"}
										decoding="async"
										alt=""
									/>
								) : (
									<RemoteImage
										className="h-full w-full object-contain"
										src={`${item._sBaseUrl}/${item._sFile}`}
										fallbackSrc="/who.jpg"
										loading={index === 0 ? "eager" : "lazy"}
										decoding="async"
										alt=""
									/>
								)}
							</div>
						</CarouselItem>
					))}
				</CarouselContent>
			</CarouselCN>
			<div
				className="flex flex-wrap items-center min-w-full justify-center min-h-fit gap-0.5 rounded-lg pointer-events-none"
				style={{
					width: w,
				}}
			>
				{previews.map((_, index) => (
					<div
						key={`preview-dot-${index}`}
						className={
							"h-1/3 min-h-2.5 aspect-square pointer-events-auto rounded-full border duration-200 " +
							(index == current ? "bg-accent bgaccent   border-accent" : " hover:bg-border")
						}
						onClick={(e) => {
							e.stopPropagation();
							if (api) {
								api.scrollTo(index);
							}
						}}
					></div>
				))}
			</div>
		</>
	);
}
export default Carousel;
