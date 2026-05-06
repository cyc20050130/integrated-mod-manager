import { Input } from "@/components/ui/input";
import {
	CATEGORIES,
	DATA,
	GAME,
	INIT_DONE,
	LAST_UPDATED,
	MOD_LIST,
	ONLINE,
	openConflict,
	SELECTED,
	SETTINGS,
	SOURCE,
	TEXT_DATA,
} from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	ArrowUpRightFromSquareIcon,
	CheckIcon,
	ChevronDownIcon,
	DownloadIcon,
	EyeIcon,
	HeartIcon,
	LinkIcon,
	MinusIcon,
	SearchIcon,
	Settings2Icon,
	SwordsIcon,
	TriangleAlertIcon,
	TrashIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { GAME_GB_IDS, GAMES, managedSRC } from "@/utils/consts";
import {
	getImageUrl,
	handleImageError,
	handleInAppLink,
	isRouteBlacklisted,
	join,
	normalizeModRoute,
	withBlacklistTag,
} from "@/utils/utils";
import { Sidebar, SidebarContent, SidebarGroup } from "@/components/ui/sidebar";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
	changeModName,
	deleteMod,
	getModDetails,
	installFromArchives,
	refreshModList,
	saveConfigs,
	selectPath,
} from "@/utils/filesys";
import { Label } from "@/components/ui/label";
import { Games, Mod, ModHotKeys } from "@/utils/types";
import ManageCategories from "./components/ManageCategories";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatHotkeyDisplay, normalizeHotkey } from "@/utils/hotkeyUtils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnimatePresence, motion } from "motion/react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { addToast } from "@/_Toaster/ToastProvider";
import ModPreferences from "./components/ModPreferences";
import { info } from "@/lib/logger";
import ModPreviewCrop from "./components/ModPreviewCrop";
import ModPreview from "./components/ModPreview";

type ModDetails = {
	keys: ModHotKeys[];
	files: Record<string, ModHotKeys[]>;
};

type StoredVarValue = Partial<Pick<ModHotKeys, "pref" | "reset" | "name">> & {
	state?: string | null;
};

type StoredVarMap = Record<string, Record<string, StoredVarValue>>;

const EMPTY_DETAILS: ModDetails = { keys: [], files: {} };
const cachedDetails: Record<string, ModDetails> = {};
const timeKey = Date.now().toString();

function mergeHotkeyWithStoredData(hotkey: ModHotKeys, modData?: StoredVarMap): ModHotKeys {
	const fileEntry = modData?.[hotkey.file]?.[hotkey.target];
	const namespaceEntry = hotkey.namespace ? modData?.namespace?.[hotkey.target] : undefined;
	const mergedEntry = namespaceEntry ?? fileEntry;

	return {
		...hotkey,
		pref: mergedEntry?.pref ?? hotkey.pref,
		reset: fileEntry?.reset ?? hotkey.reset,
		name: fileEntry?.name || hotkey.name || hotkey.target,
		state: mergedEntry?.state ?? hotkey.state ?? null,
	};
}

function formatDetails(details: ModDetails, modData?: StoredVarMap): ModDetails {
	const keys = details.keys
		.map((key) => {
			const merged = mergeHotkeyWithStoredData(key, modData);
			return {
				...merged,
				key: formatHotkeyDisplay(normalizeHotkey(merged.key)),
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));

	const files = Object.fromEntries(
		Object.entries(details.files).map(([file, hotkeys]) => [file, hotkeys.map((key) => mergeHotkeyWithStoredData(key, modData))])
	);

	return { keys, files };
}

function getTextValue(textData: Record<string, unknown>, key: string, fallback: string) {
	const value = textData[key];
	return typeof value === "string" && value.trim() ? value : fallback;
}
function RightLocal() {
	const [tab, setTab] = useState<"notes" | "hotkeys">("hotkeys");
	const setOnline = useSetAtom(ONLINE);
	const game = useAtomValue(GAME);
	const initDone = useAtomValue(INIT_DONE);
	const textData = useAtomValue(TEXT_DATA);
	// const setSettings = useSetAtom(SETTINGS);

	const [urls, setUrls] = useState<string[]>([]);
	const lastHandledUrlRef = useRef<string | null>(null);
	const switchGameToast = textData._Toasts.SwitchGame;
	const handleURLGame = useCallback(
		async (urls: string[]) => {
			const final = urls[urls.length - 1];
			if (final) getCurrentWebviewWindow()?.setFocus();
			if (final.includes("/game/")) {
				const [prefix, rest = ""] = final.split("/game/");
				const pathParts = rest.split("/");
				const gameSlug = pathParts.shift() ?? "";
				const gameId = Number.parseInt(gameSlug, 10);
				const urlGame = Number.isFinite(gameId) && Object.prototype.hasOwnProperty.call(GAME_GB_IDS, gameId)
					? GAME_GB_IDS[gameId]
					: undefined;
				info(`urlGame: ${urlGame} game: ${game}`);
				const nextUrl = [prefix, pathParts.join("/")].join("/");
				urls[urls.length - 1] = nextUrl;
				if (urlGame && urlGame != game) {
					addToast({
						message: switchGameToast.replace("<game/>", urlGame),
					});
					sessionStorage.setItem("imm-deep-link-game", urlGame);
					info("Setting deep link game in sessionStorage:", urls[urls.length - 1]);
					sessionStorage.setItem("imm-session-timestamp", timeKey);
					sessionStorage.setItem("imm-deep-link-url", urls[urls.length - 1]);
					window.location.reload();
				} else {
					throw new Error("Invalid game in URL or same as current game.");
				}
			} else if (final.includes("/mode/")) {
				const urlGame = final.split("/mode/")[1].split("/")[0].toUpperCase();
				if (urlGame && urlGame != game && GAMES.includes(urlGame as Games)) {
					sessionStorage.setItem("imm-deep-link-game", urlGame);
					window.location.reload();
				} else {
					throw new Error("Invalid game in URL or same as current game.");
				}
			}
		},
		[game, switchGameToast]
	);
	useEffect(() => {
		if (!game) {
			return () => {};
		}
		let unlisten: (() => void) | undefined;

		const initDeepLink = async () => {
			// 1. Check if app was launched via deep link
			// We use sessionStorage to ensure we only process the launch URL once per session.
			// This prevents the deep link from re-triggering on page reload (F5),
			// as the CLI args (returned by getCurrent) persist for the process lifetime.
			const initialUrls = await getCurrent();
			const isDeepLinkHandled = sessionStorage.getItem("deep-link-initial-handled");
			info("Initial URLs:", initialUrls, "Handled:", isDeepLinkHandled);
			if (initialUrls && !isDeepLinkHandled) {
				info("Launched with URLs:", initialUrls);
				sessionStorage.setItem("deep-link-initial-handled", "true");
				await handleURLGame(initialUrls).catch(() => {
					setUrls((prev) => [...prev, ...initialUrls]);
				});
			}
			// 2. Listen for deep links while app is running
			// The single-instance plugin forwards Windows deep links here automatically
			unlisten = await onOpenUrl(async (newUrls) => {
				info("Received new URLs:", newUrls);
				await handleURLGame(newUrls).catch(() => {
					setUrls((prev) => [...prev, ...newUrls]);
				});
			});
		};

		initDeepLink();

		return () => {
			if (unlisten) unlisten();
		};
	}, [handleURLGame, game]);
	useEffect(() => {
		if (!initDone) return;
		const pendingUrl = sessionStorage.getItem("imm-deep-link-url");
		info("Checking URLs after init:", pendingUrl, urls);
		if (pendingUrl && timeKey != sessionStorage.getItem("imm-session-timestamp")) {
			const url = pendingUrl;
			info("Processing pending deep link URL from sessionStorage:", url);
			handleInAppLink(url);
			sessionStorage.removeItem("imm-deep-link-url");
			lastHandledUrlRef.current = url;
			return;
		}
		const nextUrl = urls[urls.length - 1];
		if (!nextUrl || nextUrl === lastHandledUrlRef.current) return;
		info("Processing URLs after init:", urls);
		handleInAppLink(nextUrl);
		lastHandledUrlRef.current = nextUrl;
	}, [urls, initDone]);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogType, setDialogType] = useState("");
	useEffect(() => {
		if (dialogOpen && dialogType.startsWith("preview")) return () => {};
		const handlePaste = (event: ClipboardEvent) => {
			let activeEl = document.activeElement;
			if (activeEl?.tagName === "BUTTON") activeEl = null;
			if (activeEl === document.body || activeEl === null) {
				const text = event.clipboardData?.getData("Text");
				if (text?.startsWith("http")) {
					event.preventDefault();
					handleInAppLink(text);
				}
			}
		};
		document.addEventListener("paste", handlePaste);
		return () => document.removeEventListener("paste", handlePaste);
	}, [dialogOpen, dialogType]);
	const categories = useAtomValue(CATEGORIES);
	const source = useAtomValue(SOURCE);
	const [deleteItemData, setDeleteItemData] = useState<Mod | null>(null);
	// const decor = useAtomValue(SETTINGS).global.winType
	const [modList, setModList] = useAtom(MOD_LIST);
	const [selected, setSelected] = useAtom(SELECTED);
	const [data, setData] = useAtom(DATA);
	const [settings, setSettings] = useAtom(SETTINGS);

	const [alertOpen, setAlertOpen] = useState(false);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [detailCache, setDetailCache] = useState<Record<string, ModDetails>>(() => ({ ...cachedDetails }));
	const item = selected ? modList.find((mod) => mod.path == selected) : undefined;
	const category = item
		? (() => {
				const cat = categories.find((entry) => entry._sName == item.parent) || { _sName: "-1", _sIconUrl: "" };
				return { name: cat._sName, icon: cat._sIconUrl };
			})()
		: { name: "-1", icon: "" };
	const storedVars = (item ? data[item.path]?.vars : undefined) as StoredVarMap | undefined;
	const rawDetails = item ? detailCache[item.path] ?? { keys: item.keys || [], files: item.files || {} } : EMPTY_DETAILS;
	const details = formatDetails(rawDetails, storedVars);
	const handleAlertOpenChange = useCallback((open: boolean) => {
		setAlertOpen(open);
		if (!open) {
			setDeleteItemData(null);
		}
	}, []);
	function manageCategoriesButton({
		title = textData._RightSideBar._components._ManageCategories.ManageCat,
	}: {
		title?: string;
	}) {
		return (
			<Button
				onClick={() => {
					setPopoverOpen(false);
					setDialogType("categories");
					setDialogOpen(true);
				}}
				className="w-full mx-2 my-1"
			>
				<Settings2Icon className="w-4 h-4" />
				{title}
			</Button>
		);
	}
	const lastUpdated = useAtomValue(LAST_UPDATED);
	function renameMod(path: string, newPath: string) {
		changeModName(path, newPath)
			.then((newPath) => {
				if (newPath) {
					const name = newPath.split("\\").pop();
					if (name) {
						setModList((prev) => {
							return prev.map((m) => {
								if (m.path == path) {
									return { ...m, path: newPath, name, parent: newPath.split("\\")[0] };
								}
								return m;
							});
						});
					}
					setSelected(newPath);
				}
			})
			.catch(() => {
				addToast({
					message: textData._Toasts.FailedRename,
					type: "error",
				});
			});
	}
	useEffect(() => {
		if (!item || detailCache[item.path]) {
			return;
		}
		let active = true;
		getModDetails(item.path).then((nextDetails) => {
			if (!active) {
				return;
			}
			cachedDetails[item.path] = nextDetails;
			setDetailCache((prev) => ({
				...prev,
				[item.path]: nextDetails,
			}));
		});
		return () => {
			active = false;
		};
	}, [detailCache, item]);
	const tags = new Set(item?.tags || []);
	const textLookup = textData as Record<string, unknown>;
	const blacklistCopy = useMemo(
		() => ({
			label: getTextValue(textLookup, "Blacklisted", "Blacklisted"),
			add: getTextValue(textLookup, "BlacklistMod", "Blacklist Mod"),
			remove: getTextValue(textLookup, "RemoveFromBlacklist", "Remove Blacklist"),
			addedToast: getTextValue(textLookup, "BlacklistedAdded", "Mod added to blacklist."),
			removedToast: getTextValue(textLookup, "BlacklistedRemoved", "Mod removed from blacklist."),
		}),
		[textLookup]
	);
	const sourceRoute = normalizeModRoute(item?.source);
	const isCurrentBlacklisted = item?.source
		? tags.has("blacklisted") || isRouteBlacklisted(settings.global.onlineBlacklist, game, sourceRoute)
		: tags.has("blacklisted");
	const syncRouteBlacklistState = useCallback(
		(route: string, blacklisted: boolean) => {
			if (!route) return;
			setData((prev) => {
				const next = { ...prev };
				Object.entries(prev).forEach(([path, modData]) => {
					if (normalizeModRoute(modData.source) !== route) return;
					next[path] = {
						...modData,
						tags: withBlacklistTag(modData.tags, blacklisted),
					};
				});
				return next;
			});
			setModList((prev) =>
				prev.map((mod) =>
					normalizeModRoute(mod.source) === route ? { ...mod, tags: withBlacklistTag(mod.tags, blacklisted) } : mod
				)
			);
		},
		[setData, setModList]
	);
	const toggleBlacklist = useCallback(() => {
		if (!item) return;
		const nextBlacklisted = !isCurrentBlacklisted;
		if (sourceRoute) {
			setSettings((prev) => {
				const filtered = (prev.global.onlineBlacklist || []).filter(
					(entry) => !(entry.game === game && normalizeModRoute(entry.route || entry.source) === sourceRoute)
				);
				return {
					...prev,
					global: {
						...prev.global,
						onlineBlacklist: nextBlacklisted
							? [
									...filtered,
									{
										game,
										route: sourceRoute,
										source: item.source || "",
										name: item.name,
										createdAt: Date.now(),
									},
								]
							: filtered,
					},
				};
			});
			syncRouteBlacklistState(sourceRoute, nextBlacklisted);
		} else {
			setData((prev) => {
				return {
					...prev,
					[item.path]: {
						...prev[item.path],
						tags: withBlacklistTag(prev[item.path]?.tags, nextBlacklisted),
					},
				};
			});
			setModList((prev) =>
				prev.map((mod) =>
					mod.path === item.path ? { ...mod, tags: withBlacklistTag(mod.tags, nextBlacklisted) } : mod
				)
			);
		}
		saveConfigs();
		addToast({
			type: nextBlacklisted ? "error" : "success",
			message: nextBlacklisted ? blacklistCopy.addedToast : blacklistCopy.removedToast,
		});
	}, [
		blacklistCopy.addedToast,
		blacklistCopy.removedToast,
		game,
		isCurrentBlacklisted,
		item,
		setData,
		setModList,
		setSettings,
		sourceRoute,
		syncRouteBlacklistState,
	]);
	//info(item?.keys);
	return (
		<Sidebar side="right" className="pt-8 duration-300">
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				{dialogType == "edit-mod-config" && details ? (
					item ? <ModPreferences item={item} details={details} /> : null
				) : dialogType == "preview-crop" ? (
					item ? <ModPreviewCrop key={item.path} item={item} setDialogType={setDialogType} /> : null
				) : dialogType.startsWith("preview") ? (
					item ? <ModPreview item={item} setDialogType={setDialogType} isBlank={dialogType == "preview-blank"} /> : null
				) : (
					<ManageCategories />
				)}
			</Dialog>
			<AlertDialog open={alertOpen} onOpenChange={handleAlertOpenChange}>
				<AlertDialogContent>
					<div className="max-w-96 flex flex-col items-center gap-6 mt-6 text-center">
						<div className="max-w-96 text-xl text-gray-200 wrap-break-words">
							{textData._Main._MainLocal.Delete} <span className="text-accent ">{deleteItemData?.name}</span>?
						</div>
						<div className="text-destructive">{textData._Main._MainLocal.Irrev}</div>
					</div>
					<div className="flex justify-between w-full gap-4 mt-4">
						<AlertDialogCancel variant="default" className="w-24 duration-300">
							{textData.Cancel}
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							className=" w-24"
							onClick={async () => {
								if (!deleteItemData) return;
								setData((prev) => {
									const newData = { ...prev };
									if (deleteItemData.path) {
										delete newData[deleteItemData.path];
									}
									return newData;
								});
								deleteMod(deleteItemData.path);
								saveConfigs();
								setModList((prev) => {
									const newData = prev.filter((m) => m.path != deleteItemData.path);
									return newData;
								});
								setAlertOpen(false);
								setSelected("");
							}}
						>
							{textData._Main._MainLocal.Delete}
						</AlertDialogAction>
					</div>
				</AlertDialogContent>
			</AlertDialog>
			<SidebarContent className="bgpattern bg-sidebar flex flex-row w-full h-full gap-0 p-0 overflow-hidden duration-300 border border-t-0">
				<div className=" flex flex-col items-center h-full min-w-full overflow-y-hidden" key={item?.path || "no-item"}>
					<div className="text-accent min-h-10 flex items-center justify-center h-10 min-w-full gap-3 px-3 border-b">
						{item ? (
							<>
								<Button
									className="aspect-square max-h-6"
									onClick={() => {
										openPath(join(source, managedSRC, item.path));
									}}
								>
									<ArrowUpRightFromSquareIcon className="max-h-3" />
								</Button>
								<Input
									onFocus={(e) => {
										e.target.select();
									}}
									onBlur={(e) => {
										if (e.currentTarget.value != item.name) {
											renameMod(item.path, join(...item.path.split("\\").slice(0, -1), e.currentTarget.value));
										}
									}}
									type="text"
									key={item?.name || "no-item"}
									className="label text-muted-foreground text-ellipsis"
									defaultValue={item?.name || ""}
								/>
								<Button
									className="aspect-square max-h-6"
									variant="destructive"
									onClick={() => {
										setDeleteItemData(item);
										setAlertOpen(true);
									}}
								>
									<TrashIcon className="max-h-3" />
								</Button>
							</>
						) : (
							"---"
						)}
					</div>
					<SidebarGroup className="min-h-48 max-h-48 overflow-hidden w-82 mt-1 data-zzz:rounded-[1px] border rounded-lg data-zzz:rounded-tr-2xl data-zzz:rounded-bl-2xl select-nzone">
						{/* <EditIcon
							onClick={() => {
								item && savePreviewImage(item.path);
							}}
							className="min-h-8 min-w-8 bg-background/50 z-25 text-accent data-zzz:rounded-bl-2xl rounded-bl-md self-end w-12 p-2 -mb-8 border-l border-b"
						/> */}
						<img
							id="preview-bg"
							className="w-82 h-48 -mb-48 object-cover"
							onError={(e) => handleImageError(e, true)}
							src={`${getImageUrl(item?.path || "")}?${lastUpdated}`}
						></img>
						<img
							id="preview"
							
							className="w-82 h-48 -mb-48 backdrop-blur-md bg-background/50 object-contain peer"
							onError={(e) => {
								handleImageError(e);
								const next = e.currentTarget.nextElementSibling as HTMLDivElement;
								if (next && item?.path) {
									next.style.opacity = "1";
									const nextChild = next.firstElementChild as HTMLButtonElement;
									if (nextChild) {
										nextChild.innerText = "Set Preview Image";
									}
								}
							}}
							src={`${getImageUrl(item?.path || "")}?${lastUpdated}`}
						></img>
						{item?.path && (
							<div key={lastUpdated} className="w-82 h-48 flex items-center justify-center text-xs text-accent backdrop-blur-sm bg-background/20 opacity-0 pointer-events-none peer-hover:opacity-100 hover:opacity-100 duration-300">
								<Button
									className="pointer-events-auto"
									onClick={async (e) => {
										const current = e.currentTarget;
										// const parent = current.parentElement as HTMLDivElement;
										if (current.innerText == "Set Preview Image") {
											setDialogType("preview-blank");
											// const success = await savePreviewImage(item.path);
											// if (!success) {
											// 	return;
											// }
											// current.innerText = "Edit Preview Image";
											// parent.style.display = "none";
										} else setDialogType("preview-crop");
										setDialogOpen(true);
									}}
								>
									Edit Preview Image
								</Button>
							</div>
						)}
					</SidebarGroup>
					<SidebarGroup className="px-1 min-h-33.5 my-1">
						<div className="flex flex-col w-full gap-1 py-1 border rounded-lg">
							<div className="bg-pat2 flex items-center justify-between w-full px-1 rounded-lg">
								<Label className=" h-10  flex items-center justify-center  min-w-28.5 w-28.5 text-accent ">
									{textData.Category}
								</Label>
								{item?.depth == 1 ? (
									<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
										<PopoverTrigger asChild>
											<div
												role="combobox"
												className="overflow-hidden text-ellipsis active:scale-90 whitespace-nowrap rounded-md text-sm font-medium transition-all p-2 gap-2 bg-sidebar text-accent shadow-xs hover:brightness-120  duration-300 h-10 flex items-center justify-between w-48.5"
											>
												{category.name != "-1" ? (
													<>
														{" "}
														{category.name != "Uncategorized" && (
															<img
																className=" aspect-square scale-120 outline bg-accent/10 items-center justify-center h-full text-white rounded-full pointer-events-none"
																onError={(e) => {
																	e.currentTarget.src = "/who.jpg";
																}}
																src={category.icon || "err"}
															/>
														)}
														<div className="w-30 text-ellipsis overflow-hidden break-words pointer-events-none">
															{category.name}
														</div>
													</>
												) : (
													textData.Select
												)}
												<ChevronDownIcon />
											</div>
										</PopoverTrigger>
										<PopoverContent className="w-80 p-0 my-2 mr-2 border rounded-lg">
											<Command>
												<CommandInput placeholder={textData.Search} className="h-12" />
												<CommandList>
													<CommandEmpty>{textData._RightSideBar._RightLocal.NoCat}</CommandEmpty>
													<CommandGroup>
														{categories.map((cat) => (
															<CommandItem
																key={cat._sName}
																value={cat._sName}
																onSelect={(currentValue) => {
																	renameMod(item.path, join(currentValue, item.name));
																	setPopoverOpen(false);
																}}
																className="button-like zzz-fg-text data-zzz:mt-1"
															>
																<img
																	className="aspect-square outline bg-accent/10 flex items-center justify-center h-12 text-white rounded-full pointer-events-none"
																	onError={(e) => {
																		e.currentTarget.src = "/who.jpg";
																	}}
																	src={cat._sIconUrl || "err"}
																/>

																<div className="w-35 min-w-fit text-ellipsis overflow-hidden break-words">
																	{cat._sName}
																</div>
																<CheckIcon
																	className={cn("ml-auto", category.name === cat._sName ? "opacity-100" : "opacity-0")}
																/>
															</CommandItem>
														))}
													</CommandGroup>
												</CommandList>
											</Command>
										</PopoverContent>
									</Popover>
								) : (
									<div className="w-48.5 flex items-center pr-2">
										{manageCategoriesButton({ title: textData._RightSideBar._RightLocal.Manage })}
									</div>
								)}
							</div>
							<div className="bg-pat1 flex justify-between w-full px-1 rounded-lg">
								<Label className="bg-input/0 flex items-center justify-center hover:bg-input/0 h-10 w-28.5 text-accent ">
									{textData._RightSideBar._RightLocal.Source}
								</Label>
								<div className="w-48.5 flex items-center px-1">
									<Input
										onBlur={(e) => {
											if (item && e.currentTarget.value !== item?.source) {
												const nextSource = e.currentTarget.value;
												const nextRoute = normalizeModRoute(nextSource);
												const nextBlacklisted = nextRoute
													? isRouteBlacklisted(settings.global.onlineBlacklist, game, nextRoute)
													: tags.has("blacklisted");
												setData((prev) => {
													prev[item.path] = {
														...prev[item.path],
														source: nextSource,
														updatedAt: Date.now(),
														viewedAt: 0,
														tags: withBlacklistTag(prev[item.path]?.tags, nextBlacklisted),
													};
													return { ...prev };
												});
												setModList((prev) => {
													return prev.map((m) => {
														if (m.path == item.path) {
															return {
																...m,
																source: nextSource,
																tags: withBlacklistTag(m.tags, nextBlacklisted),
															};
														}
														return m;
													});
												});
												saveConfigs();
											}
										}}
										type="text"
										placeholder={textData._RightSideBar._RightLocal.NoSource}
										className="w-full select-none focus-within:select-auto overflow-hidden h-10 focus-visible:ring-[0px] border-0  text-ellipsis"
										style={{ backgroundColor: "#fff0" }}
										key={item?.source}
										defaultValue={item?.source}
									/>
									{item?.source ? (
										<Button
											className="bg-pat2"
											onClick={() => {
												if (item?.source && item?.source != "") {
													handleInAppLink(item.source || "");
												}
											}}
										>
											<Tooltip>
												<TooltipTrigger>
													<LinkIcon className=" w-4 h-4" />
												</TooltipTrigger>
												<TooltipContent className="flex items-center justify-center w-20">
													<p className="max-w-20 w-full text-center">
														{textData._RightSideBar._RightLocal.ViewModOnline}
													</p>
												</TooltipContent>
											</Tooltip>
										</Button>
									) : (
										item && (
											<Button
												onClick={() => {
													setOnline(true);
													const search = document.getElementById("search-input") as HTMLInputElement;
													setTimeout(() => {
														search.focus();
														search.value = item?.name.replaceAll("_", " ");
														search.blur();
													}, 100);
													// setRightSlideOverOpen(true);
													setSelected("");
												}}
												className="bg-pat2"
											>
												<Tooltip>
													<TooltipTrigger>
														<SearchIcon className=" w-4 h-4 pointer-events-none" />
													</TooltipTrigger>
													<TooltipContent className="w-15 flex items-center justify-center">
														<p className="max-w-15 w-full text-center">
															{textData._RightSideBar._RightLocal.SearchOnline}
														</p>
													</TooltipContent>
												</Tooltip>
											</Button>
										)
									)}
									{}
								</div>
							</div>
							{item && isCurrentBlacklisted && (
								<div className="mx-1 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
									<TriangleAlertIcon className="h-4 w-4 min-w-4" />
									<span>{blacklistCopy.label}</span>
								</div>
							)}
							<div className="bg-pat1 flex justify-between w-full px-1 rounded-lg">
								<Label className="bg-input/0 flex items-center justify-center hover:bg-input/0 h-10 w-28.5 text-accent ">
									{textData._Tags.Tags}
								</Label>
								<div className="w-48.5 flex gap-1 justify-evenly items-center px-1">
									<Tooltip>
										<TooltipTrigger>
											<Button
												onClick={() => {
													if (!item) return;
													const newTags = new Set(item.tags || []);
													if (newTags.has("fav")) {
														newTags.delete("fav");
													} else {
														newTags.add("fav");
													}
													setData((prev) => {
														prev[item.path] = {
															...prev[item.path],
															tags: Array.from(newTags),
														};
														return { ...prev };
													});
													setModList((prev) => {
														return prev.map((m) => {
															if (m.path == item.path) {
																return { ...m, tags: Array.from(newTags) };
															}
															return m;
														});
													});
													saveConfigs();
												}}
												className="aspect-square h-8"
											>
												<HeartIcon
													className="w-3.5 h-3.5 "
													style={{
														color: tags.has("fav") ? "var(--color-red-400)" : "",
														fill: tags.has("fav") ? "currentColor" : "none",
													}}
												/>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{new Set(item?.tags || []).has("fav") ? textData._Tags.RemFav : textData._Tags.AddFav}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger>
											<Button
												onClick={() => {
													if (!item) return;
													const newTags = new Set(item.tags || []);
													if (newTags.has("nsfw")) {
														newTags.delete("nsfw");
													} else {
														newTags.add("nsfw");
													}
													setData((prev) => {
														prev[item.path] = {
															...prev[item.path],
															tags: Array.from(newTags),
														};
														return { ...prev };
													});
													setModList((prev) => {
														return prev.map((m) => {
															if (m.path == item.path) {
																return { ...m, tags: Array.from(newTags) };
															}
															return m;
														});
													});
													saveConfigs();
												}}
												className="aspect-square flex flex-col h-8"
												style={{
													color: tags.has("nsfw") ? "var(--color-yellow-200)" : "",
												}}
											>
												<EyeIcon className="w-3.5 h-3.5 " />
												<MinusIcon
													className="scale-x-170 -mt-6 duration-300 rotate-45"
													style={{
														scale: tags.has("nsfw") ? "1.7 1" : "0 1",
													}}
												/>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{new Set(item?.tags || []).has("nsfw") ? textData._Tags.UnmarkNSFW : textData._Tags.MarkNSFW}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger>
											<Button
												onClick={toggleBlacklist}
												className="aspect-square flex flex-col h-8"
												variant={isCurrentBlacklisted ? "outline" : "destructive"}
											>
												<TriangleAlertIcon className="w-3.5 h-3.5" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>{isCurrentBlacklisted ? blacklistCopy.remove : blacklistCopy.add}</TooltipContent>
									</Tooltip>
								</div>
							</div>
						</div>
					</SidebarGroup>
					<SidebarGroup
						className="h-full duration-200 opacity-0"
						style={{
							opacity: item ? 1 : 0,
							marginBottom: item ? "0rem" : "-27.5rem",
						}}
					>
						<div className=" flex flex-col w-full h-full p-2 overflow-hidden">
							<Tabs
								defaultValue={tab}
								onValueChange={(val) => {
									if (val === "notes" || val === "hotkeys") {
										setTab(val);
									}
								}}
								className=" w-full min-h-full"
							>
								<TabsList className="bg-background/0 w-full h-8 gap-2">
									<TabsTrigger
										value="hotkeys"
										nbg2
										className="transparent-bg w-1/2 h-8"
										style={{
											color: tab == "hotkeys" ? "var(--accent)" : "var(--muted-foreground)",
											border: "1px solid var(--border)",
											opacity: tab == "hotkeys" ? 1 : 0.4,
										}}
									>
										{textData._RightSideBar._RightLocal.HotKeys}
									</TabsTrigger>
									<TabsTrigger
										nbg2
										value="notes"
										className="transparent-bg w-1/2 h-8"
										style={{
											color: tab !== "hotkeys" ? "var(--accent)" : "var(--muted-foreground)",
											border: "1px solid var(--border)",
											opacity: tab !== "hotkeys" ? 1 : 0.4,
										}}
									>
										{textData._RightSideBar._RightLocal.Notes}
									</TabsTrigger>
								</TabsList>
								<AnimatePresence mode="wait" initial={false}>
									<motion.div
										key={tab + item?.note}
										initial={{ opacity: 0, x: tab == "hotkeys" ? "-25%" : "25%" }}
										animate={{ opacity: 1, x: 0 }}
										exit={{ opacity: 0, x: tab == "hotkeys" ? "-25%" : "25%" }}
										transition={{ duration: 0.2 }}
										className="flex w-full h-full gap-2 border rounded-md"
									>
										{tab == "hotkeys" ? (
											<div className="text-gray-300 h-full max-h-[calc(100vh-32.75rem)] flex flex-col w-full overflow-y-scroll overflow-x-hidden">
												{item &&
													details.keys.map((hotkey, index) => (
														<div
															key={index + item.path}
															className={
																"flex border-b justify-center text-border items-center gap-2 w-full min-h-10 px-4 py-2 bg-pat" +
																(1 + (index % 2))
															}
														>
															<label className="min-w-1/3 max-w-1/3 text-accent flex-1 text-sm truncate">
																{hotkey.name}
															</label>
															|
															<div className=" flex items-center w-2/3 gap-1">
																{(hotkey.key as string).split(" ﹢ ").map((key, i, arr) => (
																	<span key={i} className="flex items-center">
																		<kbd className="text-accent bg-sidebar border-border min-w-8 px-2 py-1 text-sm font-semibold text-center border rounded-md shadow-sm">
																			{key}
																		</kbd>
																		{i < arr.length - 1 && (
																			<span className="text-muted-foreground mx-1 text-xs">+</span>
																		)}
																	</span>
																))}
															</div>
														</div>
													))}
											</div>
										) : (
											<div className="w-full h-full p-2">
												<textarea
													onBlur={(e) => {
														if (item && e.currentTarget.value !== item?.note) {
															setData((prev) => {
																prev[item.path] = {
																	...prev[item.path],
																	note: e.currentTarget.value,
																};
																return { ...prev };
															});
															setModList((prev) => {
																return prev.map((m) => {
																	if (m.path == item.path) {
																		return { ...m, note: e.currentTarget.value };
																	}
																	return m;
																});
															});
															saveConfigs();
														}
													}}
													className="w-full focus-within:outline-0 resize-none  select-none focus-within:select-auto overflow-y-scroll h-full  focus-visible:ring-[0px] border-0  text-ellipsis"
													style={{ backgroundColor: "#fff0" }}
													key={item?.note}
													placeholder={textData._RightSideBar._RightLocal.NoNotes}
													defaultValue={item?.note || ""}
												/>
											</div>
										)}
									</motion.div>
								</AnimatePresence>
							</Tabs>
						</div>
					</SidebarGroup>
					<SidebarGroup
						className="min-h-10 p-2 pt-0 mb-2 overflow-hidden"
						style={{
							maxHeight: item ? "2.5rem" : "",
						}}
					>
						{item && (
							<Button
								className="w-full h-10"
								onClick={() => {
									setDialogType("edit-mod-config");
									setDialogOpen(true);
								}}
							>
								<Settings2Icon className="w-4 h-4" />
								{textData._RightSideBar._components._ModPreferences.EditConf}
							</Button>
						)}

						<div className="w-full -mb-2 pointer-events-auto justify-between flex">
							<Button
								className="w-38.75 h-12"
								onClick={async () => {
									const files = (await selectPath({
										multiple: true,
										title: "Select .7z/.zip/.rar Archive(s) to Install Mod(s) From",
									})) as string[] | null;
									if (!files || files.length === 0) return;
									installFromArchives(files || ([] as string[])).then(async () => {
										setModList(await refreshModList());
									});
								}}
							>
								<DownloadIcon className="w-4 h-4" />
								{textData._RightSideBar._RightLocal.ManualInstall}
							</Button>
							<Button
								className="w-38.75 h-12"
								variant="destructive"
								onClick={() => {
									openConflict();
								}}
							>
								<SwordsIcon className="w-4 h-4" />
								{textData._RightSideBar._RightLocal.Conflicts}
							</Button>
						</div>
					</SidebarGroup>
				</div>
			</SidebarContent>
		</Sidebar>
	);
}

export default RightLocal;
