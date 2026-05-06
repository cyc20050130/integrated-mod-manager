import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	GAME,
	MOD_LIST,
	// LEFT_SIDEBAR_OPEN,
	ONLINE,
	ONLINE_DATA,
	ONLINE_PATH,
	ONLINE_SOURCE,
	ONLINE_SELECTED,
	ONLINE_SORT,
	ONLINE_TYPE,
	// RIGHT_SIDEBAR_OPEN,
	RIGHT_SLIDEOVER_OPEN,
	SEARCH,
	SORT,
	TEXT_DATA,
} from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	DownloadIcon,
	EyeIcon,
	// PanelLeftCloseIcon,
	// PanelLeftOpenIcon,
	// PanelRightCloseIcon,
	// PanelRightOpenIcon,
	RefreshCwIcon,
	SearchIcon,
	ThumbsUpIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Notice from "./Notice";
// import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { addToast } from "@/_Toaster/ToastProvider";
import { refreshModList } from "@/utils/filesys";
import { SORT_OPTIONS } from "@/utils/consts";
import { handleInAppLink } from "@/utils/utils";
import { buildUnifiedCardRoute, toOnlineListCard, type OnlineSourceId } from "@/utils/unifiedOnline";
import { buildUnifiedOnlineCacheKey, listUnifiedWwCards, shouldUseUnifiedWwOnline } from "@/utils/unifiedOnlineBridge";
const searched = {
	online: "",
	offline: "",
};

const DEV_UNIFIED_CARD_ID = "gamebanana:camellya-blue-dress";
const DEV_UNIFIED_AUTO_OPEN_KEY = "imm-dev-ww-unified-auto-opened";
const isDevRuntime =
	typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

function TopBar() {
	// const [leftSidebarOpen, setLeftSidebarOpen] = useAtom(LEFT_SIDEBAR_OPEN);
	// const [rightSidebarOpen, setRightSidebarOpen] = useAtom(RIGHT_SIDEBAR_OPEN);
	// const [rightSlideOverOpen, setRightSlideOverOpen] = useAtom(RIGHT_SLIDEOVER_OPEN);
	const [online, setOnline] = useAtom(ONLINE);
	const [onlineType, setOnlineType] = useAtom(ONLINE_TYPE);
	const [onlineSort, setOnlineSort] = useAtom(ONLINE_SORT);
	const [onlinePath, setOnlinePath] = useAtom(ONLINE_PATH);
	const [onlineSource, setOnlineSource] = useAtom(ONLINE_SOURCE);
	const [sort, setSort] = useAtom(SORT);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [search, setSearch] = useAtom(SEARCH);
	const [term, setTerm] = useState("");
	const textData = useAtomValue(TEXT_DATA);
	const game = useAtomValue(GAME);
	const setModList = useSetAtom(MOD_LIST);
	const setOnlineData = useSetAtom(ONLINE_DATA);
	const setOnlineSelected = useSetAtom(ONLINE_SELECTED);
	const setRightSlideOverOpen = useSetAtom(RIGHT_SLIDEOVER_OPEN);
	const devUnifiedAutoOpenPendingRef = useRef(false);

	useEffect(() => {
		const handler = setTimeout(
			() => {
				if (term?.startsWith("http")) {
					handleInAppLink(term);
					const searchInput = (document.getElementById("search-input") as HTMLInputElement) || null;
					if (searchInput) {
						searchInput.value = "";
						searchInput.blur();
					}
					if (online) setOnlinePath("home&_type=" + onlineType);
					else setSearch("");
					return;
				}
				if (online) {
					if (term.trim() === "") {
						setOnlinePath("home&type=" + onlineType);
					} else {
						setOnlinePath(`search/${term}&_type=${onlineType}`);
					}
				} else setSearch(term);
			},
			online ? 250 : 100
		);
		return () => {
			clearTimeout(handler);
		};
	}, [online, onlineType, setOnlinePath, setSearch, term]);
	useEffect(() => {
		const searchInput = (document.getElementById("search-input") as HTMLInputElement) || null;
		if (searchInput) {
			searched[online ? "offline" : "online"] = online
				? search
				: onlinePath.startsWith("search/")
					? onlinePath.split("search/")[1].split("&_type=")[0]
					: "";
			searchInput.value = online ? searched.online : searched.offline;
		}
	}, [online, onlinePath, search]);
	useEffect(() => {
		let searchInput = null as HTMLInputElement | null;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.keyCode == 116) window.location.reload(); // F5
			if (event.keyCode == 121) event.preventDefault();
			if (event.keyCode > 111 && event.keyCode < 124) return; // F1-F12
			if (!searchInput) searchInput = (document.getElementById("search-input") as HTMLInputElement) || null;
			if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
				let activeEl = document.activeElement;
				if (activeEl?.tagName === "BUTTON") activeEl = null;
				if (activeEl === document.body || activeEl === null) searchInput.focus();
				else if (event.code === "Escape" && activeEl === searchInput) {
					searchInput.value = "";
					searchInput.blur();
					if (online) setOnlinePath("home&_type=" + onlineType);
					else setSearch("");
				}
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [online, onlineType, setOnlinePath, setSearch]);
	const openDevUnifiedDetail = useCallback(async (preferredSourceId: OnlineSourceId | null = null) => {
		if (!shouldUseUnifiedWwOnline(game)) {
			return;
		}

		const devPath = "home&type=Mod";
		const devSource = "all" as const;
		setOnline(true);
		setOnlineType("Mod");
		setOnlineSort("");
		setOnlineSource(devSource);
		setOnlinePath(devPath);

		try {
			const unifiedCards = await listUnifiedWwCards({
				path: devPath,
				source: devSource,
			});
			const targetCard =
				(preferredSourceId
					? unifiedCards.find((card) => card.sources.some((source) => source.sourceId === preferredSourceId))
					: null) ||
				unifiedCards.find((card) => card.cardId === DEV_UNIFIED_CARD_ID) ||
				unifiedCards.find(
					(card) =>
						card.primarySourceId === "gamebanana" &&
						card.sources.some((source) => source.sourceId === "gamebanana")
				) ||
				unifiedCards[0];

			if (!targetCard) {
				addToast({
					type: "error",
					message: "开发态 unified 调试卡片未找到",
				});
				return;
			}

			const cacheKey = buildUnifiedOnlineCacheKey(devPath, devSource);
			const selectedRoute = buildUnifiedCardRoute(targetCard.cardId);
			const preferredSource =
				preferredSourceId && targetCard.sources.some((source) => source.sourceId === preferredSourceId)
					? preferredSourceId
					: null;
			const selectedItem = {
				...toOnlineListCard(targetCard),
				...(preferredSource ? { _unifiedPreferredSourceId: preferredSource } : {}),
			};
			setOnlineData((prev) => ({
				...prev,
				[cacheKey]: unifiedCards.map(toOnlineListCard),
				[selectedRoute]: selectedItem,
			}));
			setOnlineSelected(selectedRoute);
			setRightSlideOverOpen(true);
			addToast({
				type: "info",
				message: `已打开开发态 unified 详情：${targetCard.displayName}${preferredSource ? ` (${preferredSource})` : ""}`,
			});
		} catch (error) {
			console.error("Error opening dev unified detail:", error);
			addToast({
				type: "error",
				message: "打开开发态 unified 详情失败",
			});
		}
	}, [game, setOnline, setOnlineData, setOnlinePath, setOnlineSelected, setOnlineSort, setOnlineSource, setOnlineType, setRightSlideOverOpen]);
	useEffect(() => {
		if (!isDevRuntime || !shouldUseUnifiedWwOnline(game) || typeof sessionStorage === "undefined") {
			return;
		}
		if (sessionStorage.getItem(DEV_UNIFIED_AUTO_OPEN_KEY) === "done" || devUnifiedAutoOpenPendingRef.current) {
			return;
		}

		devUnifiedAutoOpenPendingRef.current = true;
		void openDevUnifiedDetail().finally(() => {
			sessionStorage.setItem(DEV_UNIFIED_AUTO_OPEN_KEY, "done");
			devUnifiedAutoOpenPendingRef.current = false;
		});
	}, [game, openDevUnifiedDetail]);
	return (
		<div className="text-accent min-h-16 flex items-center justify-center w-full h-16 gap-2 p-2">
			<div className="bg-sidebar button-like flex items-center justify-between w-full h-full px-3 py-1 overflow-hidden border rounded-lg">
				<SearchIcon className="text-muted-foreground flex-shrink-0 w-4 h-4 mr-2" />
				<Input
					id="search-input"
					defaultValue={online ? "" : search}
					placeholder={textData._Main._components._TopBar.Search}
					className="text-foreground zzz-rounded placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 flex-1 h-8 bg-transparent border-0"
					onChange={(e) => {
						setTerm(e.target.value);
					}}
					onBlur={(e) => {
						setTerm(e.target.value);
					}}
				/>
			</div>
			<div className="data-wuwa:bg-sidebar data-wuwa:min-w-32 min-w-28 data-wuwa:border h-full bg-transparent border-0 rounded-lg">
				{
					<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
						<PopoverTrigger asChild>
							<div className="min-w-fit button-like zzz-border hover:brightness-150 bg-sidebar cursor-pointerx flex items-center justify-center h-full gap-1 p-2 text-xs duration-300 rounded-md select-none">
								{online ? (
									onlinePath.startsWith("home") || onlinePath.startsWith("search") ? (
										onlineType == "Mod" ? (
											textData._Main._components._TopBar.ModsOnly
										) : (
											textData.All
										)
									) : onlineSort == "" ? (
										textData._Main._components._TopBar.Default
									) : (
										{
											Generic_MostLiked: (
												<>
													{textData._Main._components._TopBar.Most} <ThumbsUpIcon className="h-4" />
												</>
											),
											Generic_MostViewed: (
												<>
													{textData._Main._components._TopBar.Most} <EyeIcon className="h-4" />
												</>
											),
											Generic_MostDownloaded: (
												<>
													{textData._Main._components._TopBar.Most} <DownloadIcon className="h-4" />
												</>
											),
										}[onlineSort]
									)
								) : (
									<>{SORT_OPTIONS[sort].replace("Default",textData._Main._components._TopBar.Default).replace("Favourite",textData._Tags.Favorite)}</>
								)}
							</div>
						</PopoverTrigger>
						<PopoverContent className="data-wuwa:bg-sidebar game-font z-100 data-wuwa:w-32 w-32 data-wuwa:border absolute p-2 my-2 mr-2 -ml-16 bg-sidebar border bgpattern rounded-lg">
							<div className="data-wuwa:gap-0 flex flex-col gap-2" onClick={() => setPopoverOpen(false)}>
								{online ? (
									onlinePath.startsWith("home") || onlinePath.startsWith("search") ? (
										<>
											<div
												className="hover:brightness-150 button-like data-zzz:bg-button zzz-border bg-sidebar min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 border-b rounded-md select-none"
												onClick={() => {
													setOnlineType("");
													setOnlinePath((prev) => `${prev.split("&_type=")[0]}&_type=`);
													// setSettings((prev) => ({ ...prev, onlineType: "" }));
													// saveConfig();
												}}
											>
												{textData.All}
											</div>
											<div
												className="hover:brightness-150 bg-sidebar button-like data-zzz:bg-button zzz-border min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 border-t rounded-md select-none"
												onClick={() => {
													setOnlineType("Mod");
													setOnlinePath((prev) => `${prev.split("&_type=")[0]}&_type=Mod`);
													// setSettings((prev) => ({ ...prev, onlineType: "Mod" }));
													// saveConfig();
												}}
											>
												{textData._Main._components._TopBar.ModsOnly}
											</div>
										</>
									) : (
										<>
											<div
												className="hover:brightness-150 button-like data-zzz:bg-button zzz-border bg-sidebar min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 border-b rounded-md select-none"
												onClick={() => {
													setOnlineSort("");
													setOnlinePath((prev) => `${prev.split("&_sort=")[0]}&_sort=`);
												}}
											>
												{textData._Main._components._TopBar.Default}
											</div>
											<div
												className="hover:brightness-150 button-like data-zzz:bg-button zzz-border border-y bg-sidebar min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 rounded-md select-none"
												onClick={() => {
													setOnlineSort("Generic_MostLiked");
													setOnlinePath((prev) => `${prev.split("&_sort=")[0]}&_sort=most_liked`);
												}}
											>
												{textData._Main._components._TopBar.Most} <ThumbsUpIcon className="h-4" />
											</div>
											<div
												className="hover:brightness-150 button-like data-zzz:bg-button zzz-border border-y bg-sidebar min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 rounded-md select-none"
												onClick={() => {
													setOnlineSort("Generic_MostViewed");
													setOnlinePath((prev) => `${prev.split("&_sort=")[0]}&_sort=most_viewed`);
												}}
											>
												{textData._Main._components._TopBar.Most} <EyeIcon className="h-4" />
											</div>
											<div
												className="hover:brightness-150 button-like data-zzz:bg-button zzz-border bg-sidebar min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 border-t rounded-md select-none"
												onClick={() => {
													setOnlineSort("Generic_MostDownloaded");
													setOnlinePath((prev) => `${prev.split("&_sort=")[0]}&_sort=most_downloaded`);
												}}
											>
												{textData._Main._components._TopBar.Most} <DownloadIcon className="h-4" />
											</div>
										</>
									)
								) : (
									Object.entries(SORT_OPTIONS).map(([value, label]) => (
										<div
											key={value}
											className="hover:brightness-150 button-like data-zzz:bg-button zzz-border bg-sidebar min-h-12 cursor-pointerx flex items-center justify-center w-full gap-1 p-2 text-sm duration-300 rounded-md select-none"
											onClick={() => {
												setSort(value);
											}}
										>
											{label.replace("Default",textData._Main._components._TopBar.Default).replace("Favourite",textData._Tags.Favorite)}
										</div>
									))
								)}
							</div>
						</PopoverContent>
					</Popover>
				}
			</div>
			<Notice />
			{isDevRuntime && shouldUseUnifiedWwOnline(game) && (
				<>
					<Button
						onClick={() => {
							void openDevUnifiedDetail();
						}}
						className="bg-sidebar flex items-center justify-center min-w-fit h-12 gap-0 duration-200 border rounded-lg px-3 text-xs"
					>
						调试 GB 复用
					</Button>
					<Button
						onClick={() => {
							void openDevUnifiedDetail("hui");
						}}
						className="bg-sidebar flex items-center justify-center min-w-fit h-12 gap-0 duration-200 border rounded-lg px-3 text-xs"
					>
						调试 Hui 通用
					</Button>
					<Button
						onClick={() => {
							void openDevUnifiedDetail("keke");
						}}
						className="bg-sidebar flex items-center justify-center min-w-fit h-12 gap-0 duration-200 border rounded-lg px-3 text-xs"
					>
						调试 Keke 通用
					</Button>
				</>
			)}
			<Button
				onClick={() => {
				if (online) {
						const curPath = onlinePath;
						const cacheKey = shouldUseUnifiedWwOnline(game)
							? buildUnifiedOnlineCacheKey(curPath, onlineSource)
							: curPath;
						setOnlinePath("");
						setOnlineData((prev) => {
							delete prev[cacheKey];
							if (curPath.startsWith("home")) delete prev.banner;
							return { ...prev };
						});
						setTimeout(() => {
							setOnlinePath(curPath);
						}, 50);
					} else {
						addToast({
							type: "info",
							message: textData._Toasts.RefreshMods,
						});
						refreshModList().then((data) => {
							setModList(data);
						});
					}
				}}
				className="bg-sidebar flex items-center justify-center w-12 h-12 gap-0 duration-200 border rounded-lg"
			>
				<RefreshCwIcon></RefreshCwIcon>
			</Button>
		</div>
	);
}

export default TopBar;
