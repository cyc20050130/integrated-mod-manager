import { Button } from "@/components/ui/button";
import { fetchGameBananaJson, getGameBananaProvider, isGameBananaAbortError } from "@/utils/api";
import {
	GAME,
	INSTALLED_ITEMS,
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
import { isRouteBlacklisted, normalizeModRoute, preventContextMenu } from "@/utils/utils";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { OnlineMod } from "@/utils/types";
import CardOnline from "./components/CardOnline";
import Carousel from "./components/Carousel";

type OnlineListResponse = {
	_aMetadata?: {
		_nRecordCount?: number;
		_nPerPage?: number;
	};
	_aRecords?: OnlineMod[];
};

type PageState = {
	page: number;
	maxPage: number;
};

const pageStates: Record<string, PageState> = {};
const ONLINE_TIME_REFERENCE_SECONDS = Date.now() / 1000;

export function resetPageCounts() {
	Object.keys(pageStates).forEach((key) => {
		delete pageStates[key];
	});
}

function onlineErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error || "在线列表请求失败");
	if (/failed to fetch|connect|timed? out|dns|network/i.test(message)) {
		return "无法连接 GameBanana。请检查网络或代理后重试。";
	}
	return `GameBanana 请求失败：${message}`;
}

function MainOnline() {
	const [isLoading, setIsLoading] = useState(false);
	const [onlineLoadError, setOnlineLoadError] = useState("");
	const [reloadToken, setReloadToken] = useState(0);
	const loadingRef = useRef(false);
	const requestGenerationRef = useRef(0);
	const routeControllerRef = useRef<AbortController | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const carouselRef = useRef<HTMLDivElement | null>(null);
	const settings = useAtomValue(SETTINGS);
	const nsfw = settings.global.nsfw;
	const textData = useAtomValue(TEXT_DATA);
	const [onlineData, setOnlineData] = useAtom(ONLINE_DATA);
	const onlineType = useAtomValue(ONLINE_TYPE);
	const onlinePath = useAtomValue(ONLINE_PATH);
	const onlineSort = useAtomValue(ONLINE_SORT);
	const setRightSlideOverOpen = useSetAtom(RIGHT_SLIDEOVER_OPEN);
	const setSelected = useSetAtom(ONLINE_SELECTED);
	const types = useAtomValue(TYPES);
	const [visibleRange, setVisibleRange] = useState({ start: -1, end: -1 });
	const game = useAtomValue(GAME);
	const provider = useMemo(() => (game ? getGameBananaProvider(game) : null), [game]);
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
	const blacklistedRoutes = useMemo(
		() =>
			new Set(
				(settings.global.onlineBlacklist || [])
					.filter((entry) => entry.game === game)
					.map((entry) => normalizeModRoute(entry.route || entry.source))
					.filter(Boolean)
			),
		[game, settings.global.onlineBlacklist]
	);

	const onModClick = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>, mod: OnlineMod) => {
			if ((event.target as HTMLElement).tagName.toLowerCase() === "button") return;
			setSelected(`${mod._sModelName}/${mod._idRow}`);
			setRightSlideOverOpen(true);
		},
		[setRightSlideOverOpen, setSelected]
	);

	const clearCurrentCatalog = useCallback(() => {
		setOnlineData((previous) => ({ ...previous, [onlinePath]: [] }));
	}, [onlinePath, setOnlineData]);

	const requestPage = useCallback(
		async (page: number, signal: AbortSignal): Promise<OnlineListResponse> => {
			if (!provider) throw new Error("GameBanana provider is unavailable");
			let url: string;
			if (onlinePath.startsWith("home")) {
				url = provider.home({ page, type: onlineType, sort: onlineSort || "default" });
			} else if (types.some((type) => onlinePath.startsWith(type._sName) || onlinePath.startsWith("Skins"))) {
				url = provider.category({
					cat: onlinePath.split("&_sort=")[0],
					sort: onlineSort || "default",
					page,
					runtimeCategories: types,
				});
			} else if (onlinePath.startsWith("search/")) {
				const term = onlinePath.replace("search/", "").split("&_type=")[0].trim();
				if (!term) return { _aMetadata: { _nRecordCount: 0, _nPerPage: 15 }, _aRecords: [] };
				url = provider.search({ term, type: onlineType, page });
			} else {
				throw new Error("Unsupported online catalog route");
			}
			return fetchGameBananaJson<OnlineListResponse>(url, signal);
		},
		[onlinePath, onlineSort, onlineType, provider, types]
	);

	const loadNextPage = useCallback(async () => {
		const controller = routeControllerRef.current;
		const state = pageStates[onlinePath];
		if (!controller || controller.signal.aborted || loadingRef.current || !state || state.page >= state.maxPage) return;

		const generation = requestGenerationRef.current;
		const nextPage = state.page + 1;
		loadingRef.current = true;
		setIsLoading(true);
		try {
			const response = await requestPage(nextPage, controller.signal);
			if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
			setOnlineData((previous) => ({
				...previous,
				[onlinePath]: [
					...(((previous[onlinePath] as OnlineMod[] | undefined) || []) as OnlineMod[]),
					...(response._aRecords || []),
				],
			}));
			pageStates[onlinePath] = { ...state, page: nextPage };
		} catch (error) {
			if (controller.signal.aborted || isGameBananaAbortError(error)) return;
			pageStates[onlinePath] = { page: 1, maxPage: 1 };
			clearCurrentCatalog();
			setOnlineLoadError(onlineErrorMessage(error));
		} finally {
			if (generation === requestGenerationRef.current) {
				loadingRef.current = false;
				setIsLoading(false);
			}
		}
	}, [clearCurrentCatalog, onlinePath, requestPage, setOnlineData]);

	const checkLoadMore = useCallback(() => {
		const container = containerRef.current;
		if (!container || container.scrollHeight - container.scrollTop - container.clientHeight >= 100) return;
		void loadNextPage();
	}, [loadNextPage]);

	const updateVisibilityRange = useCallback(() => {
		if (!containerRef.current) return;
		const box = containerRef.current.getBoundingClientRect();
		const carouselHeight = carouselRef.current ? carouselRef.current.getBoundingClientRect().height + 42 : 0;
		const scrollTop = containerRef.current.scrollTop - carouselHeight;
		const itemsPerRow = Math.max(1, Math.floor(box.width / 256));
		const start = Math.floor(scrollTop / 304) * itemsPerRow;
		const end = Math.ceil((scrollTop + box.height) / 304) * itemsPerRow - 1;
		setVisibleRange((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
	}, []);

	const scrollTimeoutRef = useRef<number | null>(null);
	const handleScroll = useCallback(() => {
		if (scrollTimeoutRef.current) window.clearTimeout(scrollTimeoutRef.current);
		scrollTimeoutRef.current = window.setTimeout(() => {
			updateVisibilityRange();
			checkLoadMore();
		}, 50);
	}, [checkLoadMore, updateVisibilityRange]);

	useEffect(() => {
		const refresh = () => setReloadToken((value) => value + 1);
		window.addEventListener("imm:refresh-online", refresh);
		return () => window.removeEventListener("imm:refresh-online", refresh);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		routeControllerRef.current?.abort();
		routeControllerRef.current = controller;
		const generation = ++requestGenerationRef.current;

		void Promise.resolve().then(() => {
			if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
			loadingRef.current = true;
			setIsLoading(true);
			setOnlineLoadError("");
			setVisibleRange({ start: -1, end: -1 });
			pageStates[onlinePath] = { page: 1, maxPage: 1 };
			containerRef.current?.scrollTo({ top: 0 });
			setOnlineData((previous) => ({
				...previous,
				[onlinePath]: [],
				...(onlinePath.startsWith("home") ? { banner: [] } : {}),
			}));

			if (provider && onlinePath.startsWith("home")) {
				void fetchGameBananaJson<OnlineMod[]>(provider.banner(), controller.signal)
					.then((banner) => {
						if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
						setOnlineData((previous) => ({ ...previous, banner: banner || [] }));
					})
					.catch((error) => {
						if (!isGameBananaAbortError(error)) setOnlineData((previous) => ({ ...previous, banner: [] }));
					});
			}

			void requestPage(1, controller.signal)
				.then((response) => {
					if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
					const records = response._aRecords || [];
					const recordCount = response._aMetadata?._nRecordCount || records.length;
					const perPage = response._aMetadata?._nPerPage || 15;
					pageStates[onlinePath] = { page: 1, maxPage: Math.max(1, Math.ceil(recordCount / perPage)) };
					setOnlineData((previous) => ({ ...previous, [onlinePath]: records }));
					window.setTimeout(() => {
						if (!controller.signal.aborted && generation === requestGenerationRef.current) checkLoadMore();
					}, 100);
				})
				.catch((error) => {
					if (controller.signal.aborted || isGameBananaAbortError(error)) return;
					pageStates[onlinePath] = { page: 1, maxPage: 1 };
					clearCurrentCatalog();
					setOnlineLoadError(onlineErrorMessage(error));
				})
				.finally(() => {
					if (generation === requestGenerationRef.current) {
						loadingRef.current = false;
						setIsLoading(false);
					}
				});
		});

		return () => {
			controller.abort();
			if (routeControllerRef.current === controller) routeControllerRef.current = null;
			if (scrollTimeoutRef.current) window.clearTimeout(scrollTimeoutRef.current);
		};
	}, [checkLoadMore, clearCurrentCatalog, onlinePath, provider, reloadToken, requestPage, setOnlineData]);

	const now = ONLINE_TIME_REFERENCE_SECONDS;
	const filteredBannerData = ((onlineData.banner as OnlineMod[] | undefined) || []).filter(
		(item) => (item._sModelName === "Mod" || onlineType === "") && (nsfw || item._sInitialVisibility !== "hide")
	);
	const filteredOnlineData = ((onlineData[onlinePath] as OnlineMod[] | undefined) || []).filter(
		(item) => nsfw || item._sInitialVisibility !== "hide"
	);
	const pageState = pageStates[onlinePath];
	const hasMorePages = Boolean(pageState && pageState.page < pageState.maxPage);
	const animationVariants = {
		hidden: { opacity: 0, y: 20 },
		visible: { opacity: 1, y: 0 },
		exit: { opacity: 0, y: -20 },
	};
	const transitionConfig = (index: number) => ({
		duration: 0.3,
		ease: "easeOut" as const,
		delay: Math.min(0.3, Math.max(0, 0.05 * index)),
	});
	const isItemVisible = (index: number) => {
		const { start, end } = visibleRange;
		return start === -1 || (index >= start && index <= end) ? 0 : index < start ? 2 : 1;
	};

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
							key="banner"
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 0 }}
							transition={transitionConfig(0)}
							className="aspect-video w-full max-w-175 duration-300 transition-[max-width] xl:max-w-3xl mb-4"
						>
							<Carousel data={filteredBannerData} blur={nsfw === 1} onModClick={onModClick} />
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			<AnimatePresence mode="popLayout">
				{!isLoading && filteredOnlineData.length === 0 && onlineLoadError && (
					<motion.div
						className="mt-10 flex max-w-xl flex-col items-center gap-3 rounded-md border border-border bg-background/80 px-5 py-4 text-center text-sm text-muted-foreground"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0 }}
					>
						<span>{onlineLoadError}</span>
						<Button size="sm" variant="outline" onClick={() => setReloadToken((value) => value + 1)}>
							<RefreshCwIcon className="h-4 w-4" />
							重试
						</Button>
					</motion.div>
				)}
				<motion.div
					className="min-h-fit card-grid card-grid-online grid justify-center w-full py-4"
					layout
					key={`content-${onlinePath}`}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={transitionConfig(0)}
				>
					{filteredOnlineData.map((item, index) => {
						const modRoute = `${item._sModelName}/${item._idRow}`;
						const installedStatus = installedStatusByRoute.get(modRoute) || 0;
						const isBlacklisted =
							blacklistedRoutes.has(modRoute) || isRouteBlacklisted(settings.global.onlineBlacklist, game, modRoute);
						return (
							<motion.div
								key={modRoute}
								layout
								variants={animationVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								transition={transitionConfig(index)}
								onMouseUp={(event) => onModClick(event, item)}
								onContextMenu={preventContextMenu}
							>
								{isItemVisible(index) ? (
									<div className="card-generic card-online" />
								) : (
									<CardOnline
										{...item}
										now={now}
										blur={nsfw === 1}
										show={textData._Main._components._Filter.Show}
										isInstalled={installedStatusByRoute.has(modRoute)}
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
					>
						<LoaderIcon className="min-w-8 min-h-8 animate-spin text-accent" />
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

export default MainOnline;
