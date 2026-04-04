import { apiClient } from "@/utils/api";
import {
	GAME,
	ONLINE_DATA,
	ONLINE_PATH,
	ONLINE_SELECTED,
	ONLINE_SORT,
	ONLINE_TYPE,
	RIGHT_SLIDEOVER_OPEN,
	SETTINGS,
	TEXT_DATA,
	TYPES,
} from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CardOnline from "./components/CardOnline";

import Carousel from "./components/Carousel";
import { preventContextMenu } from "@/utils/utils";
import { LoaderIcon } from "lucide-react";
import { OnlineMod } from "@/utils/types";
import { info } from "@/lib/logger";

const pageCount = {} as any;
export function resetPageCounts() {
	Object.keys(pageCount).forEach((key) => {
		delete pageCount[key];
	});
}
let max = 0;
let prevLoaded = 0;
function MainOnline() {
	const [initial, setInitial] = useState(true);
	const containerRef = useRef(null as any);
	const carouselRef = useRef(null as any);
	const nsfw = useAtomValue(SETTINGS).global.nsfw;
	const textData = useAtomValue(TEXT_DATA);
	const [onlineData, setOnlineData] = useAtom(ONLINE_DATA);
	const onlineType = useAtomValue(ONLINE_TYPE);
	const onlinePath = useAtomValue(ONLINE_PATH);
	const onlineSort = useAtomValue(ONLINE_SORT);
	const setRightSlideOverOpen = useSetAtom(RIGHT_SLIDEOVER_OPEN);
	const [_, setSelected] = useAtom(ONLINE_SELECTED);
	const types = useAtomValue(TYPES);
	const [visibleRange, setVisibleRange] = useState({ start: -1, end: -1 });
	const game = useAtomValue(GAME);
	const onModClick = useCallback(
		(e: MouseEvent, mod: OnlineMod) => {
			let targetTag = (e.target as HTMLElement).tagName.toLowerCase();
			if (targetTag !== "button") {
				setSelected(mod ? `${mod._sModelName}/${mod._idRow}` : "");
				setRightSlideOverOpen(true);
			}
		},
		[setSelected]
	);
	const nextPage = useCallback(async (url: string, onlinePath: string) => {
		const res = await fetch(url);
		const data = await res.json();
		setOnlineData((prev) => {
			prev[onlinePath] = [...(prev[onlinePath] as OnlineMod[]), ...data._aRecords];
			return {
				...prev,
			};
		});
		loadingRef.current = false;
	}, []);
	const loadingRef = useRef(false);

	const checkLoadMore = useCallback(async () => {
		if (!containerRef.current || loadingRef.current) return;

		const container = containerRef.current;
		const { scrollTop, scrollHeight, clientHeight } = container;

		// Check if we're near the bottom (within 100px)
		if (scrollHeight - scrollTop - clientHeight < 100) {
			loadingRef.current = true;
			pageCount[onlinePath]++;

			if (max > 0 && pageCount[onlinePath] - 1 > max) {
				loadingRef.current = false;
				return;
			}
			prevLoaded = (pageCount[onlinePath] - 1) * 15;
			try {
				if (onlinePath.startsWith("home")) {
					await nextPage(apiClient.home({ page: pageCount[onlinePath], type: onlineType }), onlinePath);
				} else if (onlinePath.startsWith("Skins") || onlinePath.startsWith("Other") || onlinePath.startsWith("UI")) {
					let cat = onlinePath.split("&_sort=")[0];
					await nextPage(apiClient.category({ cat, sort: onlineSort, page: pageCount[onlinePath] }), onlinePath);
				} else if (onlinePath.startsWith("search/")) {
					let term = onlinePath.replace("search/", "").split("&_type=")[0];
					if (term.trim().length == 0) return;
					await nextPage(apiClient.search({ term, type: onlineType, page: pageCount[onlinePath] }), onlinePath);
				}
			} finally {
				loadingRef.current = false;
			}
		}
	}, [onlinePath, onlineType, onlineSort]);

	const scrollTimeoutRef = useRef<number | null>(null);
	// const scrollIntervalRef = useRef<NodeJS.Timeout | null>(null);
	const updateVisibilityRange = useCallback(() => {
		if (!containerRef.current) return;

		const box = containerRef.current.getBoundingClientRect();
		let diff = 0;
		if (carouselRef.current) {
			diff = carouselRef.current.getBoundingClientRect().height + 42;
		}
		const scrollTop = containerRef.current.scrollTop - diff;
		const itemHeight = 304;
		const itemWidth = 256;
		const itemsPerRow = Math.floor(box.width / itemWidth);

		const newStart = Math.floor(scrollTop / itemHeight) * itemsPerRow;
		const newEnd = Math.ceil((scrollTop + box.height) / itemHeight) * itemsPerRow - 1;

		// Only update if range actually changed
		setVisibleRange((prev) => {
			if (prev.start !== newStart || prev.end !== newEnd) {
				return { start: newStart, end: newEnd };
			}
			return prev;
		});
	}, [containerRef.current, carouselRef.current]);

	const handleScroll = useCallback(() => {
		// Debounce visibility calculations
		if (initial) {
			setInitial(false);
		}
		// if (!scrollIntervalRef.current) {
		// 	scrollIntervalRef.current = setInterval(() => {
		// 		updateVisibilityRange();
		// 		// Check for infinite scroll using optimized method
		// 		checkLoadMore();
		// 	}, 250); // Adjust interval as needed
		// }
		if (scrollTimeoutRef.current) {
			clearTimeout(scrollTimeoutRef.current);
		}

		scrollTimeoutRef.current = setTimeout(() => {
			// if (scrollIntervalRef.current) clearInterval(scrollIntervalRef.current);
			// scrollIntervalRef.current = null;
			updateVisibilityRange();
			// Check for infinite scroll using optimized method
			checkLoadMore();
		}, 50); // ~60fps
	}, [updateVisibilityRange, checkLoadMore, containerRef.current, carouselRef.current, initial]);
	function initialLoad(url: string, onlinePath: string, controller: AbortController) {
		fetch(url, { signal: controller.signal })
			.then((res) => res.json())
			.then((data) => {
				max = data._aMetadata._nRecordCount / (data?._aMetadata?._nPerPage || 15);
				setOnlineData((prev) => {
					prev[onlinePath] = data._aRecords;
					return {
						...prev,
					};
				});
				setTimeout(() => {
					checkLoadMore();
				}, 100);
				loadingRef.current = false;
			});
	}
	useEffect(() => {
		const controller = new AbortController();
		if (containerRef.current) {
			containerRef.current.scrollTo({ top: 0 });
		}
		setVisibleRange({ start: -1, end: -1 });
		prevLoaded = 0;
		setInitial(true);
		//info("fetching1", onlineData,onlinePath);
		//info("fetching2");
		//info("fetching3");
		//info("fetching", onlinePath, types);
		if (!onlineData[onlinePath]) {
			info("fetching", onlinePath);
			pageCount[onlinePath] = 1;
			loadingRef.current = true;
			if (onlinePath.startsWith("home")) {
				fetch(apiClient.banner(), { signal: controller.signal }).then((res) =>
					res.json().then((data) => {
						setOnlineData((prev) => {
							return {
								...prev,
								banner: data || [],
							};
						});
					})
				);
				initialLoad(apiClient.home({ type: onlineType }), onlinePath, controller);
			} else if (types.some((t) => onlinePath.startsWith(t._sName) || onlinePath.startsWith("Skins"))) {
				initialLoad(
					apiClient.category({ cat: onlinePath.split("&_sort=")[0], sort: onlineSort, page: 1 }),
					onlinePath,
					controller
				);
			} else if (onlinePath.startsWith("search/")) {
				let term = onlinePath.replace("search/", "").split("&_type=")[0];
				if (term.trim().length > 0)
					initialLoad(apiClient.search({ term, type: onlineType, page: 1 }), onlinePath, controller);
				else loadingRef.current = false;
			}
		}
		return () => {
			controller.abort();
		};
	}, [onlinePath, onlineType, game, types]);

	// Memoize the current timestamp to avoid recalculation on every render
	const now = useMemo(() => Date.now() / 1000, [onlinePath]);
	// Memoize filtered banner data
	const filteredBannerData = useMemo(() => {
		if (!onlineData?.banner) return [];
		return (onlineData.banner as OnlineMod[]).filter(
			(item) => (item._sModelName == "Mod" || onlineType == "") && (nsfw || item._sInitialVisibility != "hide")
		);
	}, [onlineData?.banner, onlineType, nsfw]);

	// Memoize filtered online data
	const filteredOnlineData = useMemo(() => {
		if (!onlineData[onlinePath]) return [];
		return (onlineData[onlinePath] as OnlineMod[]).filter((item) => nsfw || item._sInitialVisibility != "hide");
	}, [onlineData, onlinePath, nsfw]);
	// Memoize animation variants to prevent recreation on every render
	const animationVariants = useMemo(
		() => ({
			hidden: { opacity: initial ? 0 : 1, y: 20 },
			visible: { opacity: 1, y: 0 },
			exit: { opacity: initial ? 0 : 1, y: -20 },
		}),
		[initial]
	);

	// Memoize transition config
	const transitionConfig = useCallback(
		(index: number) => ({
			duration: 0.3,
			ease: "easeOut" as const,
			delay: initial ? 0.05 * index : 0,
		}),
		[]
	);

	// Determine if item should be visible
	const isItemVisible = useCallback(
		(index: number) => {
			const { start, end } = visibleRange;
			return start === -1 || (index >= start && index <= end) ? 0 : index < start ? 2 : 1;
		},
		[visibleRange]
	);
	//info(selected);
	return (
		<div
			ref={containerRef}
			onScroll={handleScroll}
			className="flex flex-col items-center h-full min-w-full overflow-x-hidden overflow-y-auto duration-300"
		>
			<div className="flex items-center justify-center h-auto min-w-full" ref={carouselRef}>
				<AnimatePresence mode="popLayout">
					{onlinePath.startsWith("home") && filteredBannerData.length > 0 && (
						<motion.div
							layout
							key={"banner"}
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 0 }}
							transition={transitionConfig(0)}
							className="aspect-video w-full max-w-175 duration-300 transition-[max-width] xl:max-w-3xl mb-4"
							
						>
							<Carousel data={filteredBannerData || []} blur={nsfw == 1} onModClick={onModClick} />
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			<AnimatePresence mode="popLayout">
				<motion.div
					className="min-h-fit card-grid card-grid-online grid justify-center w-full py-4"
					layout
					key={"content" + onlinePath}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={transitionConfig(0)}
				>
					{filteredOnlineData.map((item, index) => {
						const isVisible = isItemVisible(index);
						return (
							<motion.div
								key={`${item._sModelName}-${item._idRow}`}
								layout
								variants={animationVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								transition={transitionConfig(index - prevLoaded || 0)}
								onMouseUp={(e: any) => onModClick(e, item)}
								onContextMenu={preventContextMenu}
							>
								{isVisible ? (
									<div className="card-generic card-online"></div>
								) : (
									<CardOnline {...item} now={now} blur={nsfw == 1} show={textData._Main._components._Filter.Show} />
								)}
							</motion.div>
						);
					})}
				</motion.div>
				{(loadingRef.current || pageCount[onlinePath] < max) && (
					<motion.div
						className="min-w-8 min-h-8 flex justify-center my-2"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						key={"loader"}
						transition={transitionConfig(0)}
					>
						<LoaderIcon className="min-w-8 min-h-8 animate-spin text-accent " />
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

export default MainOnline;
