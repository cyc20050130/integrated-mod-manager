import { apiClient } from "@/utils/api";
import {
	GAME,
	INSTALLED_ITEMS,
	ONLINE_DATA,
	ONLINE_PATH,
	ONLINE_SOURCE,
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
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import CardOnline from "./components/CardOnline";

import Carousel from "./components/Carousel";
import { isRouteBlacklisted, normalizeModRoute, preventContextMenu } from "@/utils/utils";
import { LoaderIcon } from "lucide-react";
import { OnlineListItem, OnlineMod } from "@/utils/types";
import { info } from "@/lib/logger";
import { buildUnifiedOnlineCacheKey, listUnifiedWwCards, shouldUseUnifiedWwOnline } from "@/utils/unifiedOnlineBridge";
import { resolveUnifiedOnlineList, type UnifiedOnlineCard } from "@/utils/unifiedOnline";

const pageCount: Record<string, number> = {};
type OnlineListResponse = {
	_aMetadata?: {
		_nRecordCount?: number;
		_nPerPage?: number;
	};
	_aRecords?: OnlineMod[];
};
async function fetchGameBananaJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
	try {
		const payload = await invoke<unknown>("fetch_gamebanana_json", { url });
		if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
		return payload as T;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err || "Failed to fetch");
		if (/failed to fetch/i.test(message)) {
			throw new Error("无法连接 GameBanana。可能是网络、代理或 Cloudflare 拦截，请稍后再试。");
		}
		throw new Error(`无法连接 GameBanana：${message}`);
	}
}

export function resetPageCounts() {
	Object.keys(pageCount).forEach((key) => {
		delete pageCount[key];
	});
}
let max = 0;
let prevLoaded = 0;

function extractLegacyOnlineCards(items: OnlineListItem[] | undefined): OnlineMod[] {
	return (items || []).filter((item) => item._sModelName !== "UnifiedCard") as OnlineMod[];
}

function getUnifiedSearchTerm(path: string): string | undefined {
	if (!path.startsWith("search/")) return undefined;
	const term = path.replace("search/", "").split("&_type=")[0]?.trim();
	return term || undefined;
}

function MainOnline() {
	const [isLoading, setIsLoading] = useState(false);
	const [onlineLoadError, setOnlineLoadError] = useState("");
	const containerRef = useRef<HTMLDivElement | null>(null);
	const carouselRef = useRef<HTMLDivElement | null>(null);
	const unifiedCardsRef = useRef<Record<string, UnifiedOnlineCard[]>>({});
	const loadingCacheKeysRef = useRef(new Set<string>());
	const settings = useAtomValue(SETTINGS);
	const nsfw = settings.global.nsfw;
	const textData = useAtomValue(TEXT_DATA);
	const [onlineData, setOnlineData] = useAtom(ONLINE_DATA);
	const onlineDataRef = useRef(onlineData);
	const onlineSource = useAtomValue(ONLINE_SOURCE);
	const onlineType = useAtomValue(ONLINE_TYPE);
	const onlinePath = useAtomValue(ONLINE_PATH);
	const onlineSort = useAtomValue(ONLINE_SORT);
	const setRightSlideOverOpen = useSetAtom(RIGHT_SLIDEOVER_OPEN);
	const [_, setSelected] = useAtom(ONLINE_SELECTED);
	const types = useAtomValue(TYPES);
	const [visibleRange, setVisibleRange] = useState({ start: -1, end: -1 });
	const game = useAtomValue(GAME);
	const onlineCacheKey = useMemo(
		() => (shouldUseUnifiedWwOnline(game) ? buildUnifiedOnlineCacheKey(onlinePath, onlineSource) : onlinePath),
		[game, onlinePath, onlineSource]
	);
	const shouldUseUnifiedList = shouldUseUnifiedWwOnline(game);
	const appendLegacyOnlineCards = shouldUseUnifiedList && onlineSource === "all";
	const installedItems = useAtomValue(INSTALLED_ITEMS);
	const cardCopy = useMemo(
		() => ({
			installed: textData.Installed || "Installed",
			update: textData.Update || "Update",
			blacklisted: (textData as Record<string, unknown>).Blacklisted?.toString() || "Blacklisted",
		}),
		[textData]
	);
	const installedStatusByRoute = useMemo(() => {
		const routeMap = new Map<string, number>();
		installedItems.forEach((installedItem) => {
			const route = normalizeModRoute(installedItem.source);
			if (!route) return;
			routeMap.set(route, Math.max(routeMap.get(route) || 0, installedItem.modStatus || 0));
		});
		return routeMap;
	}, [installedItems]);
	const blacklistedRoutes = useMemo(() => {
		return new Set(
			(settings.global.onlineBlacklist || [])
				.filter((entry) => entry.game === game)
				.map((entry) => normalizeModRoute(entry.route || entry.source))
				.filter(Boolean)
		);
	}, [settings.global.onlineBlacklist, game]);
	const onModClick = useCallback(
		(e: ReactMouseEvent<HTMLDivElement>, mod: OnlineListItem) => {
			const targetTag = (e.target as HTMLElement).tagName.toLowerCase();
			if (targetTag !== "button") {
				const selectedRoute = mod ? `${mod._sModelName}/${mod._idRow}` : "";
				if (mod?._sModelName === "UnifiedCard" && selectedRoute) {
					setOnlineData((prev) => ({
						...prev,
						[selectedRoute]: mod,
					}));
				}
				setSelected(selectedRoute);
				setRightSlideOverOpen(true);
			}
		},
		[setOnlineData, setRightSlideOverOpen, setSelected]
	);
	const fetchUnifiedCards = useCallback(
		async (cacheKey: string) => {
			if (!shouldUseUnifiedWwOnline(game)) {
				unifiedCardsRef.current[cacheKey] = [];
				return [];
			}

			try {
				const searchTerm = getUnifiedSearchTerm(onlinePath);
				const unifiedCards = await listUnifiedWwCards({
					path: onlinePath,
					source: onlineSource,
					...(searchTerm ? { searchTerm } : {}),
					...(onlineSort ? { sort: onlineSort } : {}),
				});
				unifiedCardsRef.current[cacheKey] = unifiedCards;
				return unifiedCards;
			} catch (err) {
				info("unified ww list fallback to legacy", err);
				unifiedCardsRef.current[cacheKey] = [];
				return [];
			}
		},
		[game, onlinePath, onlineSort, onlineSource]
	);
	const nextPage = useCallback(
		async (url: string, cacheKey: string) => {
			const data = await fetchGameBananaJson<OnlineListResponse>(url);
			setOnlineData((prev) => {
				const currentItems = (prev[cacheKey] as OnlineListItem[] | undefined) || [];
				const legacyCards = shouldUseUnifiedWwOnline(game)
					? extractLegacyOnlineCards(currentItems)
					: (currentItems as OnlineMod[]) || [];
				const nextLegacyCards = [...legacyCards, ...(data._aRecords || [])];
				return {
					...prev,
					[cacheKey]: shouldUseUnifiedList
						? resolveUnifiedOnlineList(unifiedCardsRef.current[cacheKey], nextLegacyCards, {
								appendLegacy: appendLegacyOnlineCards,
							})
						: nextLegacyCards,
				};
			});
		},
		[appendLegacyOnlineCards, game, setOnlineData, shouldUseUnifiedList]
	);

	const checkLoadMore = useCallback(async () => {
		if (!containerRef.current || isLoading) return;

		const container = containerRef.current;
		const { scrollTop, scrollHeight, clientHeight } = container;

		// Check if we're near the bottom (within 100px)
		if (scrollHeight - scrollTop - clientHeight < 100) {
			pageCount[onlineCacheKey] = (pageCount[onlineCacheKey] || 0) + 1;
			setIsLoading(true);

			if (max > 0 && pageCount[onlineCacheKey] - 1 > max) {
				setIsLoading(false);
				return;
			}
			prevLoaded = (pageCount[onlineCacheKey] - 1) * 15;
			try {
				if (onlinePath.startsWith("home")) {
					await nextPage(apiClient.home({ page: pageCount[onlineCacheKey], type: onlineType }), onlineCacheKey);
				} else if (onlinePath.startsWith("Skins") || onlinePath.startsWith("Other") || onlinePath.startsWith("UI")) {
					const cat = onlinePath.split("&_sort=")[0];
					await nextPage(
						apiClient.category({ cat, sort: onlineSort, page: pageCount[onlineCacheKey] }),
						onlineCacheKey
					);
				} else if (onlinePath.startsWith("search/")) {
					const term = onlinePath.replace("search/", "").split("&_type=")[0];
					if (term.trim().length == 0) return;
					await nextPage(apiClient.search({ term, type: onlineType, page: pageCount[onlineCacheKey] }), onlineCacheKey);
				}
			} finally {
				setIsLoading(false);
			}
		}
	}, [isLoading, nextPage, onlineCacheKey, onlinePath, onlineType, onlineSort]);

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
	}, []);

	const handleScroll = useCallback(() => {
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
	}, [checkLoadMore, updateVisibilityRange]);
	const initialLoad = useCallback(
		async (url: string, cacheKey: string, controller: AbortController) => {
			setIsLoading(true);
			setOnlineLoadError("");
			try {
				const [data, unifiedCards] = await Promise.all([
					fetchGameBananaJson<OnlineListResponse>(url, controller.signal).catch((err: unknown) => {
						info("legacy online list unavailable", err);
						setOnlineLoadError(err instanceof Error ? err.message : String(err || "在线列表请求失败"));
						return null;
					}),
					fetchUnifiedCards(cacheKey),
				]);
				const legacyRecords = data?._aRecords || [];
				max = data?._aMetadata?._nRecordCount ? data._aMetadata._nRecordCount / (data?._aMetadata?._nPerPage || 15) : 0;
				setOnlineData((prev) => {
					return {
						...prev,
						[cacheKey]: shouldUseUnifiedList
							? resolveUnifiedOnlineList(unifiedCards, legacyRecords, {
									appendLegacy: appendLegacyOnlineCards,
								})
							: legacyRecords,
					};
				});
				setTimeout(() => {
					void checkLoadMore();
				}, 100);
			} finally {
				loadingCacheKeysRef.current.delete(cacheKey);
				setIsLoading(false);
			}
		},
		[appendLegacyOnlineCards, checkLoadMore, fetchUnifiedCards, game, setOnlineData, shouldUseUnifiedList]
	);
	const initialLoadRef = useRef(initialLoad);
	useEffect(() => {
		initialLoadRef.current = initialLoad;
	}, [initialLoad]);
	useEffect(() => {
		const controller = new AbortController();
		let initialLoadTimer: number | null = null;
		if (containerRef.current) {
			containerRef.current.scrollTo({ top: 0 });
		}
		const resetVisibleRangeTimer = window.setTimeout(() => {
			setVisibleRange({ start: -1, end: -1 });
		}, 0);
		max = 0;
		prevLoaded = 0;
		//info("fetching1", onlineData,onlinePath);
		//info("fetching2");
		//info("fetching3");
		//info("fetching", onlinePath, types);
		if (!onlineDataRef.current[onlineCacheKey] && !loadingCacheKeysRef.current.has(onlineCacheKey)) {
			info("fetching", onlinePath);
			loadingCacheKeysRef.current.add(onlineCacheKey);
			pageCount[onlineCacheKey] = 1;
			if (onlinePath.startsWith("home")) {
				fetchGameBananaJson<OnlineMod[]>(apiClient.banner(), controller.signal)
					.then((data) => {
						setOnlineData((prev) => {
							return {
								...prev,
								banner: data || [],
							};
						});
					})
					.catch((err) => info("legacy online banner unavailable", err));
				initialLoadTimer = window.setTimeout(() => {
					initialLoadRef.current(apiClient.home({ type: onlineType }), onlineCacheKey, controller);
				}, 0);
			} else if (types.some((t) => onlinePath.startsWith(t._sName) || onlinePath.startsWith("Skins"))) {
				initialLoadTimer = window.setTimeout(() => {
					initialLoadRef.current(
						apiClient.category({ cat: onlinePath.split("&_sort=")[0], sort: onlineSort, page: 1 }),
						onlineCacheKey,
						controller
					);
				}, 0);
			} else if (onlinePath.startsWith("search/")) {
				const term = onlinePath.replace("search/", "").split("&_type=")[0];
				if (term.trim().length > 0)
					initialLoadTimer = window.setTimeout(() => {
						initialLoadRef.current(apiClient.search({ term, type: onlineType, page: 1 }), onlineCacheKey, controller);
					}, 0);
			}
		}
		return () => {
			clearTimeout(resetVisibleRangeTimer);
			if (initialLoadTimer) clearTimeout(initialLoadTimer);
			loadingCacheKeysRef.current.delete(onlineCacheKey);
			controller.abort();
		};
	}, [onlineCacheKey, onlinePath, onlineSort, onlineType, setOnlineData, types]);

	const [now] = useState(() => Date.now() / 1000);
	const filteredBannerData = ((onlineData.banner as OnlineMod[] | undefined) || []).filter(
		(item) => (item._sModelName == "Mod" || onlineType == "") && (nsfw || item._sInitialVisibility != "hide")
	);

	const filteredOnlineData = ((onlineData[onlineCacheKey] as OnlineListItem[] | undefined) || []).filter(
		(item) => nsfw || item._sInitialVisibility != "hide"
	);
	const animationVariants = {
		hidden: { opacity: 0, y: 20 },
		visible: { opacity: 1, y: 0 },
		exit: { opacity: 0, y: -20 },
	};

	const transitionConfig = (index: number) => ({
		duration: 0.3,
		ease: "easeOut" as const,
		delay: Math.max(0, 0.05 * index),
	});

	const isItemVisible = (index: number) => {
		const { start, end } = visibleRange;
		return start === -1 || (index >= start && index <= end) ? 0 : index < start ? 2 : 1;
	};
	const hasMorePages = (pageCount[onlineCacheKey] || 0) < max;
	useEffect(() => {
		onlineDataRef.current = onlineData;
	}, [onlineData]);
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
				{!isLoading && filteredOnlineData.length === 0 && onlineLoadError && (
					<motion.div
						className="mt-10 max-w-xl rounded-md border border-border bg-background/80 px-5 py-4 text-center text-sm text-muted-foreground"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 0 }}
						transition={transitionConfig(0)}
					>
						{onlineLoadError}
					</motion.div>
				)}
				<motion.div
					className="min-h-fit card-grid card-grid-online grid justify-center w-full py-4"
					layout
					key={"content" + onlineCacheKey}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={transitionConfig(0)}
				>
					{filteredOnlineData.map((item, index) => {
						const isVisible = isItemVisible(index);
						const modRoute = `${item._sModelName}/${item._idRow}`;
						const installedStatus = installedStatusByRoute.get(modRoute) || 0;
						const isBlacklisted =
							blacklistedRoutes.has(modRoute) || isRouteBlacklisted(settings.global.onlineBlacklist, game, modRoute);
						return (
							<motion.div
								key={`${item._sModelName}-${item._idRow}`}
								layout
								variants={animationVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								transition={transitionConfig(index - prevLoaded || 0)}
								onMouseUp={(e: ReactMouseEvent<HTMLDivElement>) => onModClick(e, item)}
								onContextMenu={preventContextMenu}
							>
								{isVisible ? (
									<div className="card-generic card-online"></div>
								) : (
									<CardOnline
										{...item}
										now={now}
										blur={nsfw == 1}
										show={textData._Main._components._Filter.Show}
										isInstalled={installedStatus >= 0 && installedStatusByRoute.has(modRoute)}
										hasUpdate={installedStatus > 0}
										isBlacklisted={isBlacklisted}
										installedLabel={cardCopy.installed}
										updateLabel={cardCopy.update}
										blacklistedLabel={cardCopy.blacklisted}
									/>
								)}
							</motion.div>
						);
					})}
				</motion.div>
				{(isLoading || hasMorePages) && (
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
