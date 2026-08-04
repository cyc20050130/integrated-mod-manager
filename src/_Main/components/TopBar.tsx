import { addToast } from "@/_Toaster/ToastProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SORT_OPTIONS } from "@/utils/consts";
import { refreshModList } from "@/utils/filesys";
import { handleInAppLink } from "@/utils/utils";
import { GAME, MOD_LIST, ONLINE, ONLINE_PATH, ONLINE_SORT, ONLINE_TYPE, SEARCH, SORT, TEXT_DATA } from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	CalendarClockIcon,
	DownloadIcon,
	EyeIcon,
	RefreshCwIcon,
	SearchIcon,
	SparklesIcon,
	ThumbsUpIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import Notice from "./Notice";

const searched = {
	online: "",
	offline: "",
};

type OnlineSortOption = {
	value: string;
	pathValue: string;
	label: string;
	icon?: "newest" | "liked" | "viewed" | "downloaded" | "updated";
};

const DEFAULT_ONLINE_SORT: OnlineSortOption = { value: "", pathValue: "", label: "default" };
const NTE_ONLINE_SORTS: readonly OnlineSortOption[] = [
	DEFAULT_ONLINE_SORT,
	{ value: "Generic_Newest", pathValue: "newest", label: "最新", icon: "newest" },
	{ value: "Generic_MostLiked", pathValue: "popular", label: "热门", icon: "liked" },
	{ value: "Generic_LatestModified", pathValue: "updated", label: "最近更新", icon: "updated" },
];
const STANDARD_ONLINE_SORTS: readonly OnlineSortOption[] = [
	DEFAULT_ONLINE_SORT,
	{ value: "Generic_MostLiked", pathValue: "most_liked", label: "most", icon: "liked" },
	{ value: "Generic_MostViewed", pathValue: "most_viewed", label: "most", icon: "viewed" },
	{ value: "Generic_MostDownloaded", pathValue: "most_downloaded", label: "most", icon: "downloaded" },
];

function SortIcon({ icon }: { icon: OnlineSortOption["icon"] | undefined }) {
	switch (icon) {
		case "newest":
			return <SparklesIcon className="h-4 w-4" />;
		case "liked":
			return <ThumbsUpIcon className="h-4 w-4" />;
		case "viewed":
			return <EyeIcon className="h-4 w-4" />;
		case "downloaded":
			return <DownloadIcon className="h-4 w-4" />;
		case "updated":
			return <CalendarClockIcon className="h-4 w-4" />;
		default:
			return null;
	}
}

function TopBar() {
	const online = useAtomValue(ONLINE);
	const [onlineType, setOnlineType] = useAtom(ONLINE_TYPE);
	const [onlineSort, setOnlineSort] = useAtom(ONLINE_SORT);
	const [onlinePath, setOnlinePath] = useAtom(ONLINE_PATH);
	const [sort, setSort] = useAtom(SORT);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [search, setSearch] = useAtom(SEARCH);
	const [term, setTerm] = useState("");
	const textData = useAtomValue(TEXT_DATA);
	const game = useAtomValue(GAME);
	const setModList = useSetAtom(MOD_LIST);
	const onlineSortOptions = game === "NTE" ? NTE_ONLINE_SORTS : STANDARD_ONLINE_SORTS;
	const selectedOnlineSort = useMemo(
		() => onlineSortOptions.find((option) => option.value === onlineSort) || DEFAULT_ONLINE_SORT,
		[onlineSort, onlineSortOptions]
	);

	useEffect(() => {
		const handler = window.setTimeout(
			() => {
				if (term.startsWith("http")) {
					handleInAppLink(term);
					const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
					if (searchInput) {
						searchInput.value = "";
						searchInput.blur();
					}
					if (online) setOnlinePath(`home&_type=${onlineType}`);
					else setSearch("");
					return;
				}
				if (online) {
					setOnlinePath(term.trim() ? `search/${term}&_type=${onlineType}` : `home&type=${onlineType}`);
				} else {
					setSearch(term);
				}
			},
			online ? 250 : 100
		);
		return () => window.clearTimeout(handler);
	}, [online, onlineType, setOnlinePath, setSearch, term]);

	useEffect(() => {
		const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
		if (!searchInput) return;
		if (online) {
			searched.offline = search;
			searched.online = onlinePath.startsWith("search/") ? onlinePath.slice("search/".length).split("&_type=")[0] : "";
		} else {
			searched.online = onlinePath.startsWith("search/")
				? onlinePath.slice("search/".length).split("&_type=")[0]
				: searched.online;
			searched.offline = search;
		}
		searchInput.value = online ? searched.online : searched.offline;
	}, [online, onlinePath, search]);

	useEffect(() => {
		let searchInput: HTMLInputElement | null = null;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.keyCode === 116) window.location.reload();
			if (event.keyCode === 121) event.preventDefault();
			if (event.keyCode > 111 && event.keyCode < 124) return;
			if (!searchInput) searchInput = document.getElementById("search-input") as HTMLInputElement | null;
			if (!searchInput || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
			let activeElement = document.activeElement;
			if (activeElement?.tagName === "BUTTON") activeElement = null;
			if (activeElement === document.body || activeElement === null) {
				searchInput.focus();
			} else if (event.code === "Escape" && activeElement === searchInput) {
				searchInput.value = "";
				searchInput.blur();
				setTerm("");
				if (online) setOnlinePath(`home&_type=${onlineType}`);
				else setSearch("");
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [online, onlineType, setOnlinePath, setSearch]);

	const onlineRouteUsesType = onlinePath.startsWith("home") || onlinePath.startsWith("search");
	const onlineSortLabel =
		selectedOnlineSort.label === "default"
			? textData._Main._components._TopBar.Default
			: selectedOnlineSort.label === "most"
				? textData._Main._components._TopBar.Most
				: selectedOnlineSort.label;

	return (
		<div className="text-accent min-h-16 flex items-center justify-center w-full h-16 gap-2 p-2">
			<div className="bg-sidebar button-like flex items-center justify-between w-full h-full px-3 py-1 overflow-hidden border rounded-lg">
				<SearchIcon className="text-muted-foreground flex-shrink-0 w-4 h-4 mr-2" />
				<Input
					id="search-input"
					defaultValue={online ? searched.online : search}
					placeholder={textData._Main._components._TopBar.Search}
					className="text-foreground zzz-rounded placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 flex-1 h-8 bg-transparent border-0"
					onChange={(event) => setTerm(event.target.value)}
					onBlur={(event) => setTerm(event.target.value)}
				/>
			</div>
			<div className="data-wuwa:bg-sidebar data-wuwa:min-w-32 min-w-28 data-wuwa:border h-full bg-transparent border-0 rounded-lg">
				<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="min-w-full button-like zzz-border hover:brightness-150 bg-sidebar flex items-center justify-center h-full gap-1 p-2 text-xs duration-300 rounded-md select-none"
						>
							{online ? (
								onlineRouteUsesType ? (
									onlineType === "Mod" ? (
										textData._Main._components._TopBar.ModsOnly
									) : (
										textData.All
									)
								) : (
									<>
										{onlineSortLabel} <SortIcon icon={selectedOnlineSort.icon} />
									</>
								)
							) : (
								SORT_OPTIONS[sort]
									.replace("Default", textData._Main._components._TopBar.Default)
									.replace("Favourite", textData._Tags.Favorite)
							)}
						</button>
					</PopoverTrigger>
					<PopoverContent className="data-wuwa:bg-sidebar game-font z-100 data-wuwa:w-32 w-32 data-wuwa:border p-2 my-2 mr-2 -ml-16 bg-sidebar border bgpattern rounded-lg">
						<div className="data-wuwa:gap-0 flex flex-col gap-2" onClick={() => setPopoverOpen(false)}>
							{online
								? onlineRouteUsesType
									? [
											{ value: "", label: textData.All },
											{ value: "Mod", label: textData._Main._components._TopBar.ModsOnly },
										].map((option) => (
											<button
												type="button"
												key={option.value || "all"}
												className="hover:brightness-150 button-like zzz-border bg-sidebar min-h-12 flex items-center justify-center w-full p-2 text-sm rounded-md"
												onClick={() => {
													setOnlineType(option.value);
													setOnlinePath((previous) => `${previous.split("&_type=")[0]}&_type=${option.value}`);
												}}
											>
												{option.label}
											</button>
										))
									: onlineSortOptions.map((option) => (
											<button
												type="button"
												key={option.value || "default"}
												className="hover:brightness-150 button-like zzz-border bg-sidebar min-h-12 flex items-center justify-center w-full gap-1 p-2 text-sm rounded-md"
												onClick={() => {
													setOnlineSort(option.value);
													setOnlinePath((previous) => `${previous.split("&_sort=")[0]}&_sort=${option.pathValue}`);
												}}
											>
												{option.label === "default"
													? textData._Main._components._TopBar.Default
													: option.label === "most"
														? textData._Main._components._TopBar.Most
														: option.label}
												<SortIcon icon={option.icon} />
											</button>
										))
								: Object.entries(SORT_OPTIONS).map(([value, label]) => (
										<button
											type="button"
											key={value}
											className="hover:brightness-150 button-like zzz-border bg-sidebar min-h-12 flex items-center justify-center w-full p-2 text-sm rounded-md"
											onClick={() => setSort(value)}
										>
											{label
												.replace("Default", textData._Main._components._TopBar.Default)
												.replace("Favourite", textData._Tags.Favorite)}
										</button>
									))}
						</div>
					</PopoverContent>
				</Popover>
			</div>
			<Notice />
			<Button
				onClick={() => {
					if (online) {
						window.dispatchEvent(new Event("imm:refresh-online"));
						return;
					}
					addToast({ type: "info", message: textData._Toasts.RefreshMods });
					void refreshModList().then(setModList);
				}}
				className="bg-sidebar flex items-center justify-center w-12 h-12 gap-0 duration-200 border rounded-lg"
				aria-label={online ? "刷新 GameBanana" : textData._Toasts.RefreshMods}
			>
				<RefreshCwIcon />
			</Button>
		</div>
	);
}

export default TopBar;
