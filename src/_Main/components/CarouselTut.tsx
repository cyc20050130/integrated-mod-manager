import { useEffect, useState } from "react";
import { Carousel as CarouselCN, CarouselContent, CarouselItem } from "@/components/ui/carousel";
// import { OnlineModImage } from "@/utils/types";
import type { EmblaCarouselType } from "embla-carousel";

function CarouselTut({
	title,
	data,
	subIndex,
	setSubIndex,
}: {
	title: string;
	data: any[];
	subIndex: number;
	setSubIndex: (index: number) => void;
}) {
	const [api, setApi] = useState<EmblaCarouselType | undefined>();
	useEffect(() => {
		if (!api) return;
		const onSelect = () => {
			setSubIndex(api.selectedScrollSnap());
		};
		api.on("select", onSelect);
		return () => {
			api.off("select", onSelect);
		};
	}, [api]);
	useEffect(() => {
		if (api && subIndex >= 0) {
			api.scrollTo(subIndex);
		}
	}, [subIndex, api]);
	return (
		<>
			<CarouselCN
				setApi={setApi}
				opts={{ loop: true }}
				className="min-w-[608px]   min-h-[500px]  overflow-hidden  pointer-events-none rounded-lg"
			>
				<CarouselContent className=" min-w-full min-h-full">
					{data?.map((item, index) => (
						<CarouselItem key={index} className="flex flex-col overflow-hidden">
							<div className=" flex flex-col overflow-hidden">
								<div
									onClick={(e) => {
										if (e.target != e.currentTarget) return;
									}}
									className="w-[624px] h-[420px] z-20 flex flex-col items-center justify-between overflow-hidden  rounded-lg pointer-events-auto"
									style={{
										backgroundImage: `url(/tutorials/${title + "/" + index}.png)`,
										backgroundSize: "contain",
										backgroundPosition: "center",
										backgroundRepeat: "no-repeat",
									}}
								/>
							</div>
							<div className="text-center w-[624px] text-sm mt-2 text-gray-300">{item}</div>
						</CarouselItem>
					))}
				</CarouselContent>
			</CarouselCN>
			<div className="flex flex-wrap abs items-center w-[608px] -mt-4  justify-center min-h-fit gap-0.5 rounded-lg pointer-events-none">
				{data.length > 1 &&
					data.map((_, index) => (
						<div
							className={
								"h-1/3 min-h-2.5 aspect-square z-100 pointer-events-auto rounded-full border duration-200 " +
								(index == subIndex ? "bg-accent bgaccent   border-accent" : " hover:bg-border")
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
export default CarouselTut;
