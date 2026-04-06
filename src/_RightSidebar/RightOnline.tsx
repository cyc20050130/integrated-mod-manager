import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
	fetchMod,
	formatSize,
	getImageUrl,
	getTimeDifference,
	handleImageError,
	isRouteBlacklisted,
	modRouteFromURL,
	normalizeModRoute,
	withBlacklistTag,
} from "@/utils/utils";
import {
	DATA,
	DOWNLOAD_LIST,
	FILE_TO_DL,
	GAME,
	INSTALLED_ITEMS,
	MOD_LIST,
	ONLINE_DATA,
	ONLINE_SELECTED,
	RIGHT_SLIDEOVER_OPEN,
	SETTINGS,
	TEXT_DATA,
} from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	AngryIcon,
	ChevronDownIcon,
	DiscIcon,
	DownloadIcon,
	EllipsisVerticalIcon,
	EyeIcon,
	HeartIcon,
	HelpingHandIcon,
	InfoIcon,
	LaughIcon,
	LinkIcon,
	LoaderIcon,
	MedalIcon,
	MessageSquareIcon,
	PinIcon,
	PlusIcon,
	Redo2Icon,
	StampIcon,
	ThumbsDownIcon,
	ThumbsUpIcon,
	TriangleAlertIcon,
	Trash2Icon,
	UploadIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import Carousel from "./components/Carousel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createModDownloadDir, refreshModList, saveConfigs } from "@/utils/filesys";
import { Separator } from "@radix-ui/react-separator";
import { GAME_GB_IDS, UNCATEGORIZED } from "@/utils/consts";
import { addToast } from "@/_Toaster/ToastProvider";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { invoke } from "@tauri-apps/api/core";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiClient } from "@/utils/api";
import { DownloadItem, DownloadList } from "@/utils/types";
let now = Date.now() / 1000;
const typeToBg = {
	positive: "bg-success",
	negative: "bg-destructive",
	neutral: "bg-accent",
} as any;
function StampIcons({ title, className }: any) {
	let icon = <></>;
	switch (title) {
		case "Helpful":
			icon = <HelpingHandIcon className={className} />;
			break;
		case "Funny":
			icon = <LaughIcon className={className} />;
			break;
		case "Agree":
			icon = <ThumbsUpIcon className={className} />;
			break;
		case "Win":
			icon = <MedalIcon className={className} />;
			break;
		case "Intresting":
			icon = <PinIcon className={className} />;
			break;
		case "Thanks":
			icon = <HeartIcon className={className} />;
			break;
		case "Disagree":
			icon = <ThumbsDownIcon className={className} />;
			break;
		case "Rude":
			icon = <AngryIcon className={className} />;
			break;
		case "Toxic":
			icon = <Trash2Icon className={className} />;
			break;
		default:
			icon = <StampIcon className={className} />;
	}
	return icon;
}
function RightOnline({ open }: { open: boolean }) {
	const textData = useAtomValue(TEXT_DATA);
	const selected = useAtomValue(ONLINE_SELECTED);
	const setRightSlideOverOpen = useSetAtom(RIGHT_SLIDEOVER_OPEN);
	const [modList, setModList] = useAtom(MOD_LIST);
	const [data, setData] = useAtom(DATA);
	const [settings, setSettings] = useAtom(SETTINGS);
	const [onlineData, setOnlineData] = useAtom(ONLINE_DATA);
	const [aboutOpen, setAboutOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [commentsOpen, setCommentsOpen] = useState(false);
	const [loadingComments, setLoadingComments] = useState(false);
	const [lastSelected, setLastSelected] = useState("about");
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [altPopoverOpen, setAltPopoverOpen] = useState(false);
	const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
	const [linkExistingPopoverOpen, setLinkExistingPopoverOpen] = useState(false);
	const [cmdValue, setCmdValue] = useState("");
	const game = useAtomValue(GAME);
	const setDownloadList = useSetAtom(DOWNLOAD_LIST);
	const installedItems = useAtomValue(INSTALLED_ITEMS);
	const [fileToDl, setFileToDl] = useAtom(FILE_TO_DL);
	const item = onlineData[selected] as any;
	const [ignoreGameCheck, setIgnoreGameCheck] = useState(false);
	const gameMatched = item?._aGame ? ignoreGameCheck || GAME_GB_IDS[item._aGame._idRow] == game : false;
	const installedItem = installedItems.find((it) => it.source && modRouteFromURL(it.source) == selected) || null;
	const type = installedItem ? (installedItem.modStatus ? "Update" : "Reinstall") : "Install";
	const blacklistRoute = normalizeModRoute(selected || item?._sProfileUrl || "");
	const isBlacklisted = isRouteBlacklisted(settings.global.onlineBlacklist, game, blacklistRoute);
	const blacklistCopy = {
		label: ((textData as Record<string, any>).Blacklisted as string) || "Blacklisted",
		warning:
			((textData as Record<string, any>).BlacklistedWarning as string) ||
			"This mod is blacklisted. Installed entries with the same source stay marked.",
		add: ((textData as Record<string, any>).BlacklistMod as string) || "Blacklist Mod",
		remove: ((textData as Record<string, any>).RemoveFromBlacklist as string) || "Remove Blacklist",
		addedToast: ((textData as Record<string, any>).BlacklistedAdded as string) || "Mod added to blacklist.",
		removedToast: ((textData as Record<string, any>).BlacklistedRemoved as string) || "Mod removed from blacklist.",
	};
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
		if (!blacklistRoute) return;
		const nextBlacklisted = !isBlacklisted;
		setSettings((prev) => {
			const filtered = (prev.global.onlineBlacklist || []).filter(
				(entry) => !(entry.game === game && normalizeModRoute(entry.route || entry.source) === blacklistRoute)
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
									route: blacklistRoute,
									source: item?._sProfileUrl || "",
									name: item?._sName || "",
									createdAt: Date.now(),
								},
							]
						: filtered,
				},
			};
		});
		syncRouteBlacklistState(blacklistRoute, nextBlacklisted);
		saveConfigs();
		addToast({
			type: nextBlacklisted ? "error" : "success",
			message: nextBlacklisted ? blacklistCopy.addedToast : blacklistCopy.removedToast,
		});
	}, [blacklistRoute, isBlacklisted, setSettings, game, item, syncRouteBlacklistState, blacklistCopy]);
	const addToDownloadQueue = useCallback(
		async (file: any) => {
			setDownloadList((prev) => {
				//300ms promise await
				// await new Promise(resolve => setTimeout(resolve, 300));
				let dlitem: DownloadItem = {
					status: "pending",
					addon: altPopoverOpen,
					preview:
						item._aPreviewMedia && item._aPreviewMedia._aImages && item._aPreviewMedia._aImages.length > 0
							? item._aPreviewMedia._aImages[0]._sBaseUrl + "/" + item._aPreviewMedia._aImages[0]._sFile
							: "",
					category: item._aCategory?._sName.replaceAll("Skins", UNCATEGORIZED) || UNCATEGORIZED,
					source: item._sProfileUrl || "",
					file: file._sDownloadUrl,
					updated: file._tsDateAdded,
					name: item._sName + (altPopoverOpen ? ` - ${file._sFile}` : ""),
					displayName: item._sName,
					fname: file._sFile,
					requeueRounds: 0,
					createdAt: Date.now(),
				};
				let count = 1;
				const downloadList: DownloadItem[] = [
					...(prev?.downloading || []),
					...(prev?.extracting || []),
					...(prev?.queue || []),
					...(prev?.completed || []),
					...(prev?.failed || []),
				];
				while (
					downloadList.find((x) => x.name == dlitem.name && x.fname == dlitem.fname) ||
					modList.find((m) => m.name == dlitem.name && data[m.name]?.source !== dlitem.source)
				) {
					dlitem.name = `${item._sName} (${count})`;
					count++;
				}

				const nextList: DownloadList = {
					downloading: prev?.downloading || [],
					completed: prev?.completed || [],
					queue: [...(prev?.queue || []), dlitem],
					extracting: prev?.extracting || [],
					failed: prev?.failed || [],
				};
				return nextList;
			});
			addToast({ type: "success", message: textData._Toasts.FileAdded });
		},
		[altPopoverOpen, item, setDownloadList, modList, data]
	);
	useEffect(() => {
		now = Date.now() / 1000;
		const controller = new AbortController();
		if (selected) {
			setRightSlideOverOpen(true);
			setLoadingComments(false);
			setAboutOpen(true);
			setIgnoreGameCheck(false);
			setLastSelected("about");
			setCommentsOpen(false);
			setUpdateOpen(false);
			setPopoverOpen(false);
			setAltPopoverOpen(false);
			fetchMod(selected, controller);
		} else {
			setRightSlideOverOpen(false);
		}
		return () => {
			controller.abort();
		};
	}, [selected]);
	useEffect(() => {
		if (type != "Install" && item?._sProfileUrl) {
			installedItem &&
				setData((prev: any) => {
					if (installedItem.name) {
						prev[installedItem.name] = { ...prev[installedItem.name], viewedAt: now * 1000 };
					}
					return { ...prev };
				});
			refreshModList().then((list) => {
				setModList(list);
			});
			saveConfigs();
		}
	}, [selected, item]);
	useEffect(() => {
		if (item?._aFiles && gameMatched && fileToDl) {
			const file = item._aFiles.find((f: any) => f._idRow == fileToDl);
			if (file) {
				addToDownloadQueue(file);
				setFileToDl("");
			}
		}
	}, [item?._aFiles, fileToDl, addToDownloadQueue, game]);
	const getComments = useCallback(
		async (signal: AbortSignal) => {
			try {
				if (selected && onlineData[selected]) {
					const item = onlineData[selected] as any;
					item._aComments = item._aComments || {
						total: 0,
						count: 0,
						data: {},
						list: [],
					};
					const data = await apiClient.comments(selected, Math.floor(item._aComments.count / 15) + 1, signal);
					if (!data || signal.aborted) return;
					data._aRecords = (data._aRecords || []).filter((comment: any) => comment._aPoster);
					item._aComments = {
						...item._aComments,
						total: data._aMetadata._nRecordCount,
						count: data._aMetadata._bIsComplete
							? data._aMetadata._nRecordCount
							: item._aComments.count + data._aMetadata._nPerpage,
						data: {
							...item._aComments.data,
							...Object.fromEntries(
								data._aRecords.map((comment: any) => [
									comment._idRow,
									{
										...comment,
										_aLabels: new Set(comment._aLabels || []),
									},
								])
							),
						},
						list: [...item._aComments.list, ...data._aRecords.map((comment: any) => comment._idRow)],
					};
					setOnlineData((prev) => ({ ...prev, [selected]: { ...prev[selected], _aComments: item._aComments } }));
				}
			} catch (e) {
				console.error("Error fetching comments:", e);
			}
			setLoadingComments(false);
		},
		[selected, onlineData]
	);
	const viewReplies = useCallback(
		async (e: React.MouseEvent<HTMLButtonElement>, comment: any) => {
			e.currentTarget.disabled = true;
			try {
				const children = ((await apiClient.nestedcomments(comment._idRow))?._aRecords || []).filter(
					(comment: any) => comment._aPoster
				);
				setOnlineData((prev: any) => {
					return {
						...prev,
						[selected]: {
							...prev[selected],
							_aComments: {
								...prev[selected]._aComments,
								data: {
									...prev[selected]._aComments.data,
									[comment._idRow]: {
										...prev[selected]._aComments.data[comment._idRow],
										children: children.map((c: any) => c._idRow),
									},
									...Object.fromEntries(
										children.map((c: any) => [
											c._idRow,
											{
												...c,
												_aLabels: new Set(c._aLabels || []),
											},
										])
									),
								},
							},
						},
					};
				});
			} catch (err) {
				console.error("Error fetching replies:", err);
				e.currentTarget.disabled = false;
			}
		},
		[selected, onlineData]
	);
	useEffect(() => {
		if (loadingComments && selected) {
			const controller = new AbortController();
			getComments(controller.signal);
			return () => {
				controller.abort();
			};
		}
		return () => {};
	}, [selected, loadingComments]);
	const popoverContent = item?._aFiles?.map((file: any) => (
		<Button
			className="min-h-fit data-wuwa:p-2 flex items-center justify-center min-w-full gap-1 p-4 overflow-hidden"
			style={{
				borderRadius: game == "GI" ? "4px" : "4px",
			}}
			onClick={() => {
				addToDownloadQueue(file);
				setPopoverOpen(false);
				setAltPopoverOpen(false);
			}}
		>
			<div className="w-[calc(100%-6rem)] text-start flex flex-col gap-1">
				<p className=" text-ellipsis wrap-break-word overflow-hidden text-base resize-none">{file._sFile}</p>
				<div className=" min-w-fit text-background flex flex-wrap w-full gap-1 text-xs">
					{file._aAnalysisWarnings?.contains_exe ? (
						<div className=" bg-destructive item flex justify-center w-12 px-1 text-center rounded-lg">Exe</div>
					) : (
						""
					)}
					{file._sAnalysisState == "done" ? (
						<>
							{file._sAvState == "done" && file._sAvResult == "clean" ? (
								<div className=" bg-success w-16 px-1 text-center rounded-lg">
									{textData._RightSideBar._RightOnline.Clean}
								</div>
							) : (
								<div className=" bg-destructive w-16 px-1 text-center rounded-lg">
									{textData._RightSideBar._RightOnline.Danger}
								</div>
							)}
						</>
					) : (
						<div className=" bg-warn w-12 px-1 text-center rounded-lg">
							{textData._RightSideBar._RightOnline.Pending}
						</div>
					)}
				</div>
				<div className="flex items-center gap-1">
					{file._sDescription && file._sDescription.length > 0 && (
						<Tooltip>
							<TooltipTrigger>
								<InfoIcon />
							</TooltipTrigger>
							<TooltipContent className="max-w-64 w-fit text-center">
								<p className="max-w-64 text-center break-words">{file._sDescription}</p>
							</TooltipContent>
						</Tooltip>
					)}
					<p className="w-52 text-ellipsis brightness-75 wrap-break-word overflow-hidden text-xs resize-none">
						{file._sDescription}
					</p>
				</div>
			</div>
			<div className="min-w-24 flex flex-col items-center">
				<div className="flex gap-1">
					{" "}
					<LoaderIcon />
					{getTimeDifference(now, file._tsDateAdded)}
				</div>
				<div className="flex gap-1">
					{" "}
					<DownloadIcon />
					{file._nDownloadCount}
				</div>
				<div className=" flex gap-1">
					{" "}
					<DiscIcon />
					{formatSize(file._nFilesize || 0)}
				</div>
			</div>
		</Button>
	));
	function recursiveComments(list: any[], depth = 0): any {
		return (
			<div className="flex flex-col w-full gap-4">
				{list.map((commentId: any, index: number) => {
					const comment = item._aComments.data[commentId];
					return (
						<>
							{index > 0 && <hr />}
							<div
								key={commentId}
								className="flex select-none flex-col bg-input/20 rounded gap-2"
								onDoubleClick={(e) => {
									let lastChild = e.currentTarget.lastElementChild as HTMLDivElement;
									if (lastChild) {
										if (lastChild.style.height == "0px") lastChild.style.height = "auto";
										else lastChild.style.height = "0px";
									}
								}}
							>
								<div
									className={`flex items-center rounded p-1 pt-2 pl-2 gap-2 ${comment._aLabels.has("Submitter") && "bg-accent/10"}`}
								>
									<img
										className="aspect-square outline bg-accent/10 flex items-center justify-center object-cover h-10 text-white rounded-full pointer-events-none"
										onError={handleImageError}
										src={comment._aPoster?._sAvatarUrl || "err"}
									/>
									<div className="flex flex-col">
										{comment._aPoster?._sUpicUrl ? (
											<img src={comment._aPoster?._sUpicUrl} className="max-h-4" alt="User Pic" />
										) : (
											<span className="text-accent select-text font-medium">{comment._aPoster?._sName}</span>
										)}
										<span className="text-[10px] font-medium">{comment._aPoster?._sUserTitle}</span>
									</div>
									{comment._aLabels.has("Submitter") && (
										<span className="text-xs rounded px-1 bg-accent text-background">{"Submitter"}</span>
									)}
									<span className="text-xs text-gray-400">
										{getTimeDifference(now, comment._tsDateModified || comment._tsDateAdded || 0)}
									</span>
									{comment._iPinLevel > 0 && <PinIcon className="h-4 fill-accent stroke-accent" />}
									{comment._aPoster?._sSigUrl && (
										<img src={comment._aPoster?._sSigUrl} className="max-h-4" alt="User Pic" />
									)}
									{comment._aStamps?.map((stamp: any) => (
										<span
											className={`text-xs rounded px-1 ${typeToBg[stamp._sCategory]} flex items-center justify-center text-background`}
										>
											<StampIcons className={" max-h-4"} title={stamp._sTitle} />
											{stamp._sTitle} {stamp._nCount > 1 ? `x${stamp._nCount}` : ""}
										</span>
									))}
								</div>
								<div className="w-full flex flex-col gap-4 h-auto overflow-hidden pl-14 pb-3 pr-3">
									<div
										className="w-full select-text duration-200 font-sans "
										dangerouslySetInnerHTML={{ __html: comment._sText }}
									/>
									{comment.children?.length > 0 && recursiveComments(comment.children, depth + 1)}
									{comment._nReplyCount > 0 && !comment.children && (
										<Button
											variant="outline"
											size="sm"
											className="self-start"
											onClick={async (e) => {
												viewReplies(e, comment);
											}}
										>
											{textData._RightSideBar._RightOnline.ViewReps}
										</Button>
									)}
								</div>
							</div>
						</>
					);
				})}
			</div>
		);
	}
	return (
		<AnimatePresence mode="wait">
			{open && (
				<motion.div
					initial={{ translateX: "100%", opacity: 0 }}
					animate={{ translateX: "0%", opacity: 1 }}
					exit={{ translateX: "100%", opacity: 0 }}
					transition={{ duration: 0.3, ease: "linear" }}
					className="bg-sidebar bgpattern fixed right-0 z-10 flex flex-col items-center justify-center h-full pt-8 overflow-hidden border-l"
					style={{
						maxWidth: "47vw",
						width: "50rem",
						backdropFilter: "blur(8px)",
						backgroundColor: "color-mix(in oklab, var(--sidebar) 75%, transparent)",
					}}
				>
					<AnimatePresence mode="wait">
						{!selected ? (
							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
								key="no-selection"
								className="text-accent flex items-center justify-center h-full p-4"
							>
								{textData._RightSideBar._RightOnline.NoItem}
							</motion.div>
						) : !onlineData[selected] ? (
							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
								key="loading"
								className="text-accent flex items-center justify-center h-full p-4"
							>
								<LoaderIcon className="animate-spin" />
							</motion.div>
						) : item && (item._bIsPrivate || item._bIsTrashed || item._bIsWithheld) ? (
							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
								key="loading"
								className="text-accent flex flex-col items-center justify-center h-full gap-4 p-4"
							>
								{
									textData._RightSideBar._RightOnline[
										item._bIsPrivate ? "Private" : item._bIsTrashed ? "Deleted" : "Withheld"
									]
								}
								{selected.startsWith("Mod") && (
									<a
										href={`https://gamebanana.com/${selected.replace("Mod", "mods")}`}
										target="_blank"
										className="text-xs"
									>
										{textData._RightSideBar._RightOnline.OpenBrowser}
									</a>
								)}
							</motion.div>
						) : (
							<motion.div
								key={"loaded" + selected}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
								className="flex flex-col items-center w-full h-full overflow-hidden duration-300"
							>
								<div className="text-accent min-h-16 flex items-center justify-start w-full gap-3 px-3 border-b">
									<div className="min-w-fit trs bg-button zzz-border flex items-center gap-2 p-2 rounded-md">
										<img
											className="aspect-square min-w-6 max-w-6 scale-120 ctrs h-full rounded-full pointer-events-none"
											onError={(e) => {
												e.currentTarget.src = "/who.jpg";
											}}
											src={item._aCategory?._sIconUrl || "err"}
										/>

										<span className="ctrs">{item._aCategory?._sName.split(" ")[0]}</span>
									</div>

									<Label key={item._sName} className="w-full text-xl text-center">
										{item._sName}
									</Label>

									<Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
										<PopoverTrigger className="focus-within:outline-none">
											<div className="min-w-fit button-like ring-transparent outline-transparent aspect-square bg-button zzz-border flex items-center gap-2 p-3 rounded-md">
												<LinkIcon className="h-4 w-4" />
											</div>
										</PopoverTrigger>
										<PopoverContent className="w-fit bg-sidebar flex flex-col p-2">
											<Button
												onClick={() => {
													navigator.clipboard.writeText(item._sProfileUrl || "");
													addToast({ type: "success", message: textData._RightSideBar._RightOnline.LinkCopied });
													setLinkPopoverOpen(false);
													setLinkExistingPopoverOpen(false);
												}}
											>
												{textData._RightSideBar._RightOnline.CopyLink}
											</Button>
											<Button
												className="w-full mt-2"
												onClick={() => {
													const a = document.createElement("a");
													a.href = item._sProfileUrl || "";
													a.target = "_blank";
													document.body.appendChild(a);
													a.click();
													document.body.removeChild(a);
													setLinkPopoverOpen(false);
													setLinkExistingPopoverOpen(false);
												}}
											>
												{textData._RightSideBar._RightOnline.OpenBrowser}
											</Button>

											{gameMatched && (
												<Popover
													open={linkExistingPopoverOpen}
													onOpenChange={(open) => {
														setLinkExistingPopoverOpen(open);
														setCmdValue(item._sName);
													}}
												>
													<PopoverTrigger>
														<Button className="min-w-fit w-full mt-2">
															{textData._RightSideBar._RightOnline.LinkToMod}
														</Button>
													</PopoverTrigger>
													<PopoverContent className="w-84 -mt-37.5 min-h-40 bg-sidebar p-2 flex flex-col">
														<Command>
															<CommandInput
																placeholder={textData.Search}
																value={cmdValue}
																onValueChange={setCmdValue}
																className="h-12"
															/>
															<CommandList>
																<CommandEmpty>{textData._RightSideBar._RightLocal.NoCat}</CommandEmpty>
																<CommandGroup>
																	{modList.map((mod) => (
																		<CommandItem
																			key={mod.name}
																			value={mod.path + " " + mod.path.replaceAll("/", " ").replaceAll("_", " ")}
																			onSelect={async () => {
																				const currentValue = mod.path;
																				if (
																					item._aPreviewMedia &&
																					item._aPreviewMedia._aImages &&
																					item._aPreviewMedia._aImages.length > 0
																				) {
																					invoke("download_and_unzip", {
																						fileName: "preview",
																						downloadUrl:
																							item._aPreviewMedia._aImages[0]._sBaseUrl +
																							"/" +
																							item._aPreviewMedia._aImages[0]._sFile,
																						savePath: await createModDownloadDir(mod.parent, mod.name),
																						key: "link_preview_" + mod.name,
																						emit: false,
																					});
																				}
																				setData((prev) => {
																					prev[currentValue] = {
																						...prev[currentValue],
																						source: item._sProfileUrl,
																						updatedAt: Date.now(),
																						viewedAt: 0,
																						tags: withBlacklistTag(prev[currentValue]?.tags, isBlacklisted),
																					};
																					return { ...prev };
																				});
																				setModList((prev) => {
																					return prev.map((m) => {
																						if (m.path == currentValue) {
																							return {
																								...m,
																								source: item._sProfileUrl,
																								tags: withBlacklistTag(m.tags, isBlacklisted),
																							};
																						}
																						return m;
																					});
																				});
																				saveConfigs();
																				addToast({
																					type: "success",
																					message: textData._RightSideBar._RightOnline.LinkToModSuccess,
																				});
																				setLinkPopoverOpen(false);
																				setLinkExistingPopoverOpen(false);
																			}}
																			className="button-like zzz-fg-text data-zzz:mt-1"
																		>
																			<img
																				className="aspect-square outline bg-accent/10 flex items-center justify-center object-cover h-12 text-white rounded-full pointer-events-none"
																				onError={(e) => {
																					e.currentTarget.src = "/who.jpg";
																				}}
																				src={getImageUrl(mod.path) || "err"}
																				style={{}}
																			/>

																			<div className="text-ellipsis whitespace-nowrap max-w-56 w-full overflow-hidden break-words">
																				{mod.name}
																			</div>
																			{/* <CheckIcon
																	className={cn("ml-auto", category.name === cat._sName ? "opacity-100" : "opacity-0")}
																/> */}
																		</CommandItem>
																	))}
																</CommandGroup>
															</CommandList>

															{/* <div className="pr-5">{manageCategoriesButton({})}</div> */}
														</Command>
													</PopoverContent>
												</Popover>
											)}
										</PopoverContent>
									</Popover>
									<div className="min-w-fit trs bg-button zzz-border flex items-center gap-2 p-2 rounded-md">
										<img
											className="aspect-square min-w-6 max-w-6 scale-120 ctrs h-full rounded-full pointer-events-none"
											onError={(e) => {
												e.currentTarget.src = "/who.jpg";
											}}
											src={item._aSubmitter?._sAvatarUrl || "err"}
										/>

										<span className="ctrs">{item._aSubmitter?._sName}</span>
									</div>
								</div>
								{gameMatched ? (
									<>
										{isBlacklisted && (
											<div className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
												<TriangleAlertIcon className="h-4 w-4 min-w-4" />
												<div className="flex flex-col">
													<span className="font-medium">{blacklistCopy.label}</span>
													<span className="text-xs opacity-90">{blacklistCopy.warning}</span>
												</div>
											</div>
										)}
										<div id="container" className="flex flex-col w-full pb-2 mb-24 overflow-hidden overflow-y-scroll">
											<div
												key={item._sName + "pix"}
												className="min-h-fit flex flex-col items-center w-full max-h-full gap-1 px-2 mt-2 mb-3 overflow-hidden pointer-events-none"
											>
												{item._aPreviewMedia &&
													item._aPreviewMedia._aImages &&
													item._aPreviewMedia._aImages.length > 0 && <Carousel data={item._aPreviewMedia._aImages} />}
											</div>
											{item._sText && (
												<Collapsible
													key={item._sName + "abt"}
													id="about"
													className="w-full px-2 pb-3"
													open={aboutOpen}
													onOpenChange={(open) => {
														setAboutOpen(open);
														if (open) setLastSelected("about");
													}}
												>
													<CollapsibleTrigger className="text-accent flex items-center justify-between w-full h-8">
														<Button
															className={
																"w-full flex justify-between bg-accent bgaccent   text-background " +
																(aboutOpen
																	? "hover:brightness-125"
																	: "bg-input/50 text-accent hover:text-accent hover:bg-input")
															}
														>
															{textData._RightSideBar._RightOnline.About}{" "}
															<ChevronDownIcon
																id="deschev"
																className=" transform-[roate(180deg)] duration-200"
																style={{ transform: aboutOpen ? "rotate(180deg)" : "rotate(0deg)" }}
															/>
														</Button>
													</CollapsibleTrigger>
													<CollapsibleContent className="border-accent w-full pt-2 pl-2 mt-2">
														<div className="w-full font-sans" dangerouslySetInnerHTML={{ __html: item._sText }}></div>
													</CollapsibleContent>
												</Collapsible>
											)}
											{item._eUpdate && (
												<Collapsible
													key={item._sName + "upd"}
													id="updates"
													className=" w-full px-2 pb-3"
													open={updateOpen}
													onOpenChange={(open) => {
														setUpdateOpen(open);
														if (open) setLastSelected("update");
													}}
												>
													<CollapsibleTrigger className="text-accent flex items-center justify-between w-full h-8">
														<Button
															className={
																"w-full flex justify-between bg-accent bgaccent   text-background " +
																(updateOpen
																	? "hover:brightness-125"
																	: "bg-input/50 text-accent hover:text-accent hover:bg-input")
															}
														>
															{textData._RightSideBar._RightOnline.Updates}{" "}
															<ChevronDownIcon
																id="deschev"
																className=" transform-[roate(180deg)] duration-200"
																style={{ transform: updateOpen ? "rotate(180deg)" : "rotate(0deg)" }}
															/>
														</Button>
													</CollapsibleTrigger>
													<CollapsibleContent className="border-accent flex flex-col w-full gap-4  pt-2 mt-2">
														{item._aUpdates &&
															item._aUpdates.length > 0 &&
															item._aUpdates.map((itm: any, index: number) => (
																<>
																	{index > 0 && <hr className="border-accent/50"/>}

																	<div className="flex rounded flex-col gap-2 bg-input/10 p-2">
																		<div className="text-accent flex items-center justify-between pb-4 border-b">
																			{itm._sName}
																			<label className="flex flex-col text-xs text-gray-300">
																				{" "}
																				<label>{itm._sVersion}</label>{" "}
																				<label className=" text-cyan-200">
																					{getTimeDifference(now, itm._sDate || 0)}
																				</label>
																			</label>
																		</div>
																		<div className=" flex flex-col gap-2">
																			{itm._aChangeLog &&
																				itm._aChangeLog.map((changeItem: any, index: number) => (
																					<div key={index} className="flex items-center gap-2">
																						<div className="min-w-2 min-h-2 self-start mt-1.75 bg-accent bgaccent   rounded-full" />
																						<label className=" text-cyan-50 font-sans text-sm">
																							{changeItem.text}- [{changeItem.cat}]
																						</label>
																					</div>
																				))}
																		</div>
																		{itm._sText && (
																			<div
																				className="w-full font-sans"
																				dangerouslySetInnerHTML={{ __html: itm._sText }}
																			/>
																		)}
																	</div>
																</>
															))}
													</CollapsibleContent>
												</Collapsible>
											)}

											<Collapsible
												key={item._sName + "cmt"}
												id="comments"
												className="w-full px-2 pt-1 pb-1"
												open={commentsOpen}
												onOpenChange={(open) => {
													setCommentsOpen(open);
													setLastSelected("comments");
													if (open && (!item._aComments || item._aComments.length == 0)) {
														setLoadingComments(true);
													}
												}}
											>
												<CollapsibleTrigger className="text-accent flex items-center justify-between w-full h-8">
													<Button
														className={
															"w-full flex justify-between bg-accent bgaccent   text-background " +
															(commentsOpen
																? "hover:brightness-125"
																: "bg-input/50 text-accent hover:text-accent hover:bg-input")
														}
													>
														{textData._RightSideBar._RightOnline.Comments}{" "}
														<ChevronDownIcon
															id="deschev"
															className=" transform-[roate(180deg)] duration-200"
															style={{ transform: commentsOpen ? "rotate(180deg)" : "rotate(0deg)" }}
														/>
													</Button>
												</CollapsibleTrigger>
												<CollapsibleContent className="border-accent w-full pt-2 mt-2">
													{item._aComments && item._aComments.total > 0
														? recursiveComments(item._aComments.list, 0)
														: !loadingComments && (
																<div className="flex items-center justify-center w-full p-4 text-accent">
																	{textData._RightSideBar._RightOnline.NoComs}
																</div>
															)}
													{loadingComments ? (
														<div className="flex items-center justify-center w-full p-4">
															<LoaderIcon className="animate-spin" />
														</div>
													) : (
														item._aComments &&
														item._aComments.count < item._aComments.total && (
															<Button
																className="w-full mt-2"
																onClick={() => {
																	setLoadingComments(true);
																}}
															>
																{textData._RightSideBar._RightOnline.LoadMore}
															</Button>
														)
													)}
												</CollapsibleContent>
											</Collapsible>

											<div className="flex min-h-14 w-fit self-center items-center justify-center sticky bottom-0 gap-2 bg-background/50 rounded border button-like backdrop-blur-md p-2 mr-2 transition-opacity mt-2 z-10 duration-200">
												{item._sText && (
													<Button
														className={
															"w flex justify-between bg-accent text-background " +
															(lastSelected == "about"
																? "hover:brightness-125"
																: "bg-input/50 text-accent hover:text-accent hover:bg-input")
														}
														onClick={() => {
															setAboutOpen(true);
															setLastSelected("about");
															setTimeout(() => {
																const container = document.getElementById("container");
																const about = document.getElementById("about");
																if (about && container) {
																	container.scrollTo({
																		top: about.offsetTop - container.offsetTop - 10,
																		behavior: "smooth",
																	});
																}
															}, 50);
														}}
													>
														{textData._RightSideBar._RightOnline.About}
													</Button>
												)}
												{item._eUpdate && (
													<Button
														className={
															"w flex justify-between bg-accent text-background " +
															(lastSelected == "update"
																? "hover:brightness-125"
																: "bg-input/50 text-accent hover:text-accent hover:bg-input")
														}
														onClick={() => {
															setUpdateOpen(true);
															setLastSelected("update");
															setTimeout(() => {
																const container = document.getElementById("container");
																const updates = document.getElementById("updates");
																if (updates && container) {
																	container.scrollTo({
																		top: updates.offsetTop - container.offsetTop - 10,
																		behavior: "smooth",
																	});
																}
															}, 50);
														}}
													>
														{textData._RightSideBar._RightOnline.Updates}
													</Button>
												)}
												{
													<Button
														className={
															"w flex justify-between bg-accent text-background " +
															(lastSelected == "comments"
																? "hover:brightness-125"
																: "bg-input/50 text-accent hover:text-accent hover:bg-input")
														}
														onClick={() => {
															setCommentsOpen((prev) => {
																if (!prev && (!item._aComments || item._aComments.length == 0)) {
																	setLoadingComments(true);
																}
																return true;
															});

															setLastSelected("comments");
															setTimeout(() => {
																const container = document.getElementById("container");
																const comments = document.getElementById("comments");
																if (comments && container) {
																	container.scrollTo({
																		top: comments.offsetTop - container.offsetTop - 10,
																		behavior: "smooth",
																	});
																}
															}, 50);
														}}
													>
														{textData._RightSideBar._RightOnline.Comments}
													</Button>
												}
											</div>
										</div>
										<div className="text-accent min-h-24 justify-evenly absolute bottom-0 flex items-center h-24 min-w-full gap-1 px-1 border-t">
											<div className="min-w-40 grid w-40 grid-cols-3 gap-2 text-xs">
												{[
													<>
														<PlusIcon className="min-h-4 h-4" />
														{getTimeDifference(now, item._tsDateAdded || 0)}
													</>,
													<>
														<LoaderIcon className="h-4" />
														{getTimeDifference(now, item._tsDateModified || 0)}
													</>,
													<>
														<ThumbsUpIcon className="h-4" />
														{item._nLikeCount || "0"}
													</>,

													<>
														<MessageSquareIcon className="h-4" />
														{item._nPostCount || "0"}
													</>,
													<>
														<DownloadIcon className="h-4" />
														{item._nDownloadCount || "0"}
													</>,
													<>
														<EyeIcon className="h-4" />
														{item._nViewCount || "0"}
													</>,
												].map((children) => (
													<label className="zzz-fg-text text-accent flex flex-col items-center justify-center">
														{children}
													</label>
												))}
											</div>
											<Separator className="min-w-0 min-h-full border-l" />
											<div className="min-w-fit flex items-center justify-center w-full gap-1">
												<Button
													variant={isBlacklisted ? "outline" : "destructive"}
													className="min-w-34"
													onClick={toggleBlacklist}
												>
													<TriangleAlertIcon className="h-4 w-4" />
													{isBlacklisted ? blacklistCopy.remove : blacklistCopy.add}
												</Button>
												<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
													<PopoverTrigger
														style={{ width: `${type == "Install" ? "19.5rem" : "16.5rem"}` }}
														className="flex h-10 gap-4 overflow-hidden text-ellipsis bg-button zzz-fg-text button-like text-accent shadow-xs hover:brightness-120  duration-300  items-center justify-center active:scale-90 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"
														disabled={!item._aFiles || item._aFiles?.length == 0}
													>
														{{ Install: <DownloadIcon />, Reinstall: <Redo2Icon />, Update: <UploadIcon /> }[type]}
														{
															{
																Install: textData.Install,
																Reinstall: textData._RightSideBar._RightOnline.Reinstall,
																Update: textData.Update,
															}[type]
														}
													</PopoverTrigger>
													<PopoverContent
														className="w-152 max-w-[calc(42vw-11.625rem)] mr-1 max-h-[75vh] overflow-auto gap-1 bg-sidebar p-1 flex flex-col"
														style={{ marginLeft: type == "Install" ? "0rem" : "3rem", marginBottom: "0.5rem" }}
													>
														{popoverContent}
													</PopoverContent>
												</Popover>

												{type !== "Install" && (
													<Popover open={altPopoverOpen} onOpenChange={setAltPopoverOpen}>
														<PopoverTrigger
															className="w-10 flex h-10 gap-4 overflow-hidden text-ellipsis button-like zzz-fg-text bg-button text-accent shadow-xs hover:brightness-120  duration-300  items-center justify-center active:scale-90 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"
															disabled={!item._aFiles || item._aFiles?.length == 0}
														>
															<EllipsisVerticalIcon />
														</PopoverTrigger>
														<PopoverContent className="w-152 max-w-[calc(42vw-11.625rem)] mr-2 max-h-[75vh] mb-2 overflow-auto gap-1 bg-sidebar p-1 flex flex-col">
															<Label className="bg-accent/25 data-zzz:bg-zzz-accent-2/25 data-zzz:text-zzz-accent-2 text-accent flex items-center justify-center w-full h-12 text-lg rounded-md">
																{textData._RightSideBar._RightOnline.Sep}
															</Label>
															{popoverContent}
														</PopoverContent>
													</Popover>
												)}
											</div>
										</div>
									</>
								) : (
									<div key="notgame" className="text-accent flex flex-col items-center justify-center h-full gap-4 p-4">
										{textData._RightSideBar._RightOnline.ForGame.replace("<game/>", item._aGame._sName)}
										<div className="flex items-center justify-center gap-10">
											<Button
												onClick={() => {
													setIgnoreGameCheck(true);
												}}
											>
												{textData._RightSideBar._RightOnline.ViewAnyways}
											</Button>
											{GAME_GB_IDS.hasOwnProperty(item._aGame._idRow) && (
												<Button
													onClick={() => {
														const game = GAME_GB_IDS[item._aGame._idRow];
														if (game) {
															const url = item._sProfileUrl;
															addToast({
																message: textData._Toasts.SwitchGame.replace("<game/>", item._aGame._sName),
															});
															sessionStorage.setItem("imm-deep-link-game", game);
															console.log("Setting deep link game in sessionStorage:", url);
															sessionStorage.setItem("imm-session-timestamp", Date.now().toString());
															sessionStorage.setItem("imm-deep-link-url", url || "");
															window.location.reload();
														}
													}}
												>
													{textData._RightSideBar._RightOnline.SwitchGame.replace("<game/>", item._aGame._sName)}
												</Button>
											)}
										</div>
									</div>
								)}
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

export default RightOnline;
