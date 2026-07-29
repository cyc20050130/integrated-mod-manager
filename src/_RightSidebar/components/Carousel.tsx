import { useEffect, useState } from "react";
import { Carousel as CarouselCN, CarouselContent, CarouselItem } from "@/components/ui/carousel";
// import { OnlineModImage } from "@/utils/types";
import type { EmblaCarouselType } from "embla-carousel";
import { RemoteImage } from "@/components/RemoteImage";

type PreviewImageLike = { _sBaseUrl: string; _sFile: string };

function Carousel({ data, big }: { data: PreviewImageLike[]; big?: boolean }) {
	big = big || false;
	const w = big ? "45rem" : "12.5rem";
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
	return (
		<>
			<CarouselCN
				setApi={setApi}
				opts={{ loop: true }}
				className="aspect-video min-w-full max-w-full min-h-[calc(100%-4rem)] overflow-hidden  pointer-events-none rounded-lg"
			>
				<CarouselContent className="aspect-video min-w-full min-h-full">
					{data?.map((item, index) => (
						<CarouselItem key={index} className="flex flex-col overflow-hidden">
							<div className="flex aspect-video flex-col overflow-hidden rounded-lg border bg-black/20">
								<RemoteImage
									className="h-full w-full object-contain"
									src={item._sBaseUrl + "/" + item._sFile}
									fallbackSrc="/who.jpg"
									loading={index === 0 ? "eager" : "lazy"}
									decoding="async"
									alt=""
								/>
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
				{data?.map((_, index) => (
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
