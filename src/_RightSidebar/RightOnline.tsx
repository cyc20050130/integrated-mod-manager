import { Button } from "@/components/ui/button";
import { SafeHtml } from "@/components/SafeHtml";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { DownloadItem, DownloadList, type ModDataObj, type OnlineData, type OnlineListItem } from "@/utils/types";
import { error as logError, info as logInfo } from "@/lib/logger";
import { isSafeExternalUrl } from "@/utils/sanitizeHtml";
import {
	buildUnifiedDownloadQueueItem,
	buildUnifiedDuplicateSummary,
	buildUnifiedDuplicateEvidenceRows,
	buildUnifiedAfdianDiscoveryQuery,
	areAfdianCandidatesFresh,
	buildUnifiedDetailCapabilityLabels,
	buildUnifiedDetailLinkRows,
	buildUnifiedDetailOverviewRows,
	buildUnifiedDetailPreviewImages,
	buildUnifiedDetailUpdateRows,
	buildUnifiedDownloadOptions,
	buildUnifiedSourceRefreshRows,
	findUnifiedListCardForSource,
	findUnifiedGenericFallbackSourceId,
	findPreferredAfdianCandidate,
	replaceUnifiedListCard,
	isUnifiedCardRoute,
	resolveUnifiedDetailViewState,
	resolveUnifiedDetailCard,
	resolveUnifiedDetailSourceNote,
	toOnlineListCard,
	type LegacyOnlineListCard,
	type OnlineSourceId,
	type UnifiedOnlineCard,
	type UnifiedOnlineListCard,
	type UnifiedSourceVariant,
} from "@/utils/unifiedOnline";
import {
	buildUnifiedOnlineCacheKey,
	attachAfdianCandidateToUnifiedCard,
	discoverAfdianCandidates,
	detachAfdianSourceFromUnifiedCard,
	getUnifiedWwCardDetail,
	refreshUnifiedWwCache,
	refreshUnifiedWwSources,
	type AfdianDiscoveryResult,
	type UnifiedOnlineDetail,
	type UnifiedRefreshStatus,
} from "@/utils/unifiedOnlineBridge";
let now = Date.now() / 1000;
const typeToBg = {
	positive: "bg-success",
	negative: "bg-destructive",
	neutral: "bg-accent",
} as const;
function StampIcons({ title, className }: { title: string; className?: string }) {
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
type OnlineStampCategory = keyof typeof typeToBg;

interface OnlineStamp {
	_sCategory: OnlineStampCategory;
	_sTitle: string;
	_nCount: number;
}

interface OnlineComment {
	_idRow: number;
	_aPoster?: {
		_sAvatarUrl?: string;
		_sName?: string;
		_sSigUrl?: string;
		_sUpicUrl?: string;
		_sUserTitle?: string;
	};
	_aLabels?: Set<string> | string[];
	_aStamps?: OnlineStamp[];
	_tsDateModified?: number;
	_tsDateAdded?: number;
	_iPinLevel?: number;
	_sText?: string;
	_nReplyCount?: number;
	children?: number[];
	[key: string]: unknown;
}

interface OnlineCommentState {
	total: number;
	count: number;
	data: Record<number, OnlineComment>;
	list: number[];
}

interface OnlineDownloadFile {
	_idRow?: number | string;
	_sDownloadUrl: string;
	_tsDateAdded: number;
	_sFile: string;
	_sDescription?: string;
	_sAnalysisState?: string;
	_sAvState?: string;
	_sAvResult?: string;
	_aAnalysisWarnings?: {
		contains_exe?: boolean;
	};
	_sClamAvResult?: string;
	_nFilesize?: number;
	_nDownloadCount?: number;
	[key: string]: unknown;
}

interface LegacyChangeLogItem {
	text?: string;
	cat?: string;
}

interface LegacyUpdateItem {
	_sName?: string;
	_sVersion?: string;
	_sDate?: number;
	_aChangeLog?: LegacyChangeLogItem[];
	_sText?: string;
}

interface LegacyDetailItem {
	_sName?: string;
	_sText?: string;
	_eUpdate?: unknown;
	_aUpdates?: LegacyUpdateItem[];
	_aComments?: OnlineCommentState;
}

interface SelectedOnlineItem extends LegacyDetailItem {
	_unifiedCard?: UnifiedOnlineCard | null;
	_unifiedPreferredSourceId?: OnlineSourceId | null;
	_aFiles?: OnlineDownloadFile[];
	_aGame: {
		_idRow: number;
		_sName: string;
	};
	_aCategory: {
		_sName: string;
		_sIconUrl?: string;
	};
	_aRootCategory?: {
		_sName: string;
		_sIconUrl?: string;
	};
	_aSubmitter: {
		_sAvatarUrl?: string;
		_sName?: string;
	};
	_aPreviewMedia?: {
		_aImages?: Array<{
			_sBaseUrl: string;
			_sFile: string;
		}>;
	};
	_sProfileUrl: string;
	_sName: string;
	_tsDateAdded?: number;
	_tsDateModified?: number;
	_nLikeCount?: number;
	_nPostCount?: number;
	_nDownloadCount?: number;
	_nViewCount?: number;
	_sModelName?: string;
	_bIsPrivate?: boolean;
	_bIsTrashed?: boolean;
	_bIsWithheld?: boolean;
	[key: string]: unknown;
}

const EMPTY_SELECTED_ONLINE_ITEM: SelectedOnlineItem = {
	_aGame: { _idRow: 0, _sName: "" },
	_aCategory: { _sName: "" },
	_aSubmitter: {},
	_sProfileUrl: "",
	_sName: "",
};

function isSelectedOnlineItem(value: unknown): value is SelectedOnlineItem {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as {
		_sProfileUrl?: unknown;
		_sName?: unknown;
		_aGame?: unknown;
		_aCategory?: unknown;
	};
	return (
		typeof candidate._sProfileUrl === "string" &&
		typeof candidate._sName === "string" &&
		typeof candidate._aGame === "object" &&
		candidate._aGame !== null &&
		typeof candidate._aCategory === "object" &&
		candidate._aCategory !== null
	);
}

function getSelectedOnlineItem(data: OnlineData, key: string | null | undefined): SelectedOnlineItem {
	if (!key) return EMPTY_SELECTED_ONLINE_ITEM;
	const value = data[key];
	return isSelectedOnlineItem(value) ? value : EMPTY_SELECTED_ONLINE_ITEM;
}

function getUnifiedCacheItems(
	data: OnlineData,
	key: string
): Array<UnifiedOnlineListCard | LegacyOnlineListCard> | undefined {
	const value = data[key];
	return Array.isArray(value) ? (value as Array<UnifiedOnlineListCard | LegacyOnlineListCard>) : undefined;
}

function RightOnline({ open }: { open: boolean }) {
	const isDevRuntime =
		typeof window !== "undefined" &&
		(window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
	const textData = useAtomValue(TEXT_DATA);
	const selected = useAtomValue(ONLINE_SELECTED);
	const setOnlineSelected = useSetAtom(ONLINE_SELECTED);
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
	const [selectedUnifiedSourceId, setSelectedUnifiedSourceId] = useState<OnlineSourceId | null>(null);
	const [unifiedDetail, setUnifiedDetail] = useState<UnifiedOnlineDetail | null>(null);
	const [unifiedRefreshStatuses, setUnifiedRefreshStatuses] = useState<UnifiedRefreshStatus[]>([]);
	const [refreshingUnifiedSourceId, setRefreshingUnifiedSourceId] = useState<OnlineSourceId | "all" | null>(null);
	const [afdianCandidates, setAfdianCandidates] = useState<AfdianDiscoveryResult["candidates"]>([]);
	const [afdianCandidatesQuery, setAfdianCandidatesQuery] = useState("");
	const [cmdValue, setCmdValue] = useState("");
	const unifiedCacheKey = buildUnifiedOnlineCacheKey("home&type=Mod", "all");
	const devLegacyReuseAutomationRef = useRef({
		route: "",
		commentsOpened: false,
		loadedMore: false,
		replyCommentId: 0,
	});
	const devUnifiedGenericVerificationRef = useRef<{
		route: string;
		switched: boolean;
		targetSourceId: OnlineSourceId | "";
		visitedSourceIds: OnlineSourceId[];
		openedSourceCards: OnlineSourceId[];
	}>({
		route: "",
		switched: false,
		targetSourceId: "",
		visitedSourceIds: [],
		openedSourceCards: [],
	});
	const devAfdianAdoptionRef = useRef<{
		route: string;
		adoptedCardIds: string[];
		revokedCardIds: string[];
	}>({
		route: "",
		adoptedCardIds: [],
		revokedCardIds: [],
	});
	const commentsFetchInFlightRef = useRef(false);
	const game = useAtomValue(GAME);
	const setDownloadList = useSetAtom(DOWNLOAD_LIST);
	const installedItems = useAtomValue(INSTALLED_ITEMS);
	const [fileToDl, setFileToDl] = useAtom(FILE_TO_DL);
	const item = getSelectedOnlineItem(onlineData, selected);
	const unifiedCard = item?._unifiedCard ?? null;
	const isUnifiedSelected = isUnifiedCardRoute(selected || "");
	const effectiveUnifiedCard = resolveUnifiedDetailCard(unifiedCard, unifiedDetail);
	const unifiedDetailViewState = resolveUnifiedDetailViewState({
		selectedRoute: selected,
		card: effectiveUnifiedCard,
		detail: unifiedDetail,
		preferredSourceId: selectedUnifiedSourceId,
		legacyRouteResolver: modRouteFromURL,
	});
	const activeUnifiedSource = unifiedDetailViewState.activeSource;
	const unifiedPreviewImages = effectiveUnifiedCard
		? buildUnifiedDetailPreviewImages(effectiveUnifiedCard, selectedUnifiedSourceId, unifiedDetail)
		: [];
	const activeUnifiedDownloads = effectiveUnifiedCard
		? buildUnifiedDownloadOptions(effectiveUnifiedCard, selectedUnifiedSourceId, unifiedDetail)
		: [];
	const unifiedRefreshRows = effectiveUnifiedCard
		? buildUnifiedSourceRefreshRows(effectiveUnifiedCard, unifiedRefreshStatuses)
		: [];
	const unifiedDuplicateSummary = effectiveUnifiedCard ? buildUnifiedDuplicateSummary(effectiveUnifiedCard) : "";
	const unifiedDuplicateEvidenceRows = effectiveUnifiedCard ? buildUnifiedDuplicateEvidenceRows(effectiveUnifiedCard) : [];
	const unifiedDetailCapabilityLabels = buildUnifiedDetailCapabilityLabels(unifiedDetail);
	const unifiedDetailOverviewRows =
		effectiveUnifiedCard && unifiedDetail
			? buildUnifiedDetailOverviewRows(effectiveUnifiedCard, unifiedDetail, selectedUnifiedSourceId)
			: [];
	const unifiedDetailLinkRows =
		effectiveUnifiedCard && unifiedDetail
			? buildUnifiedDetailLinkRows(effectiveUnifiedCard, unifiedDetail, selectedUnifiedSourceId)
			: [];
	const unifiedDetailUpdates = unifiedDetail ? buildUnifiedDetailUpdateRows(unifiedDetail, selectedUnifiedSourceId) : [];
	const unifiedDetailDescription = activeUnifiedSource?.description || unifiedDetail?.description || "";
	const unifiedDetailDescriptionHtml = activeUnifiedSource?.descriptionHtml || unifiedDetail?.descriptionHtml || "";
	const unifiedDetailSourceNote = resolveUnifiedDetailSourceNote(unifiedDetail, selectedUnifiedSourceId);
	const unifiedAfdianQuery = effectiveUnifiedCard ? buildUnifiedAfdianDiscoveryQuery(effectiveUnifiedCard, unifiedDetail) : "";
	const applyAdoptedAfdianDetail = useCallback(
		(detail: UnifiedOnlineDetail, detailUrl: string) => {
			setUnifiedDetail(detail);
			setSelectedUnifiedSourceId("afdian");
			setAfdianCandidates((prev) => prev.filter((entry) => entry.detailUrl !== detailUrl));
			setOnlineData((prev) => ({
				...prev,
				[unifiedCacheKey]: replaceUnifiedListCard(
					getUnifiedCacheItems(prev, unifiedCacheKey),
					detail.card
				) as OnlineListItem[],
				[selected]: {
					...toOnlineListCard(detail.card),
					_unifiedPreferredSourceId: "afdian",
				},
			}));
			setUnifiedRefreshStatuses((prev) => {
				const next = prev.filter((status) => status.sourceId !== "afdian");
				return [
					...next,
					{
						sourceId: "afdian",
						status: "success",
						message: "Afdian candidate adopted into unified source list.",
					},
				];
			});
		},
		[selected, setOnlineData, unifiedCacheKey]
	);
	const applyDetachedAfdianDetail = useCallback(
		(detail: UnifiedOnlineDetail) => {
			setUnifiedDetail(detail);
			setSelectedUnifiedSourceId(detail.card.primarySourceId as OnlineSourceId);
			setOnlineData((prev) => ({
				...prev,
				[unifiedCacheKey]: replaceUnifiedListCard(
					getUnifiedCacheItems(prev, unifiedCacheKey),
					detail.card
				) as OnlineListItem[],
				[selected]: toOnlineListCard(detail.card),
			}));
			setUnifiedRefreshStatuses((prev) => {
				const next = prev.filter((status) => status.sourceId !== "afdian");
				return [
					...next,
					{
						sourceId: "afdian",
						status: "idle",
						message: "Afdian candidate restored to pending list.",
					},
				];
			});
		},
		[selected, setOnlineData, unifiedCacheKey]
	);
	const refreshUnifiedCache = useCallback(
		async (sourceId: OnlineSourceId | "all") => {
			setRefreshingUnifiedSourceId(sourceId);
			setUnifiedRefreshStatuses((prev) => {
				const requestedSources =
					sourceId === "all" ? (["hui", "keke", "afdian", "gamebanana"] as OnlineSourceId[]) : [sourceId];
				const retained = prev.filter((status) => !requestedSources.includes(status.sourceId));
				return [
					...retained,
					...requestedSources.map((source) => ({
						sourceId: source,
						status: "refreshing" as const,
						message: "正在刷新缓存...",
					})),
				];
			});
			try {
				const statuses = await refreshUnifiedWwCache(sourceId);
				setUnifiedRefreshStatuses(statuses);
				setOnlineData((prev) =>
					Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith("ww-unified:"))) as OnlineData
				);
				addToast({ type: "success", message: "在线源缓存刷新完成，重新进入列表会加载新缓存。" });
			} catch (error) {
				logError("Error refreshing unified source cache:", error);
				addToast({ type: "error", message: "在线源缓存刷新失败，详情页会显示最近一次状态。" });
				const statuses = await refreshUnifiedWwSources().catch(() => []);
				setUnifiedRefreshStatuses(statuses);
			} finally {
				setRefreshingUnifiedSourceId(null);
			}
		},
		[setOnlineData]
	);
	const legacyReuseRoute = unifiedDetailViewState.legacyReuseRoute;
	const shouldReuseLegacyGamebananaDetail = unifiedDetailViewState.shouldReuseLegacyComments;
	const legacyReuseItem = shouldReuseLegacyGamebananaDetail ? getSelectedOnlineItem(onlineData, legacyReuseRoute) : null;
	const commentsTargetRoute = unifiedDetailViewState.commentsTargetRoute;
	const commentsTargetItem = commentsTargetRoute ? getSelectedOnlineItem(onlineData, commentsTargetRoute) : null;
	const [ignoreGameCheck, setIgnoreGameCheck] = useState(false);
	const gameMatched = item?._aGame ? ignoreGameCheck || GAME_GB_IDS[item._aGame._idRow] == game : false;
	const installedItem = installedItems.find((it) => it.source && modRouteFromURL(it.source) == selected) || null;
	const type = installedItem ? (installedItem.modStatus ? "Update" : "Reinstall") : "Install";
	const blacklistRoute = normalizeModRoute(selected || item?._sProfileUrl || "");
	const isBlacklisted = isRouteBlacklisted(settings.global.onlineBlacklist, game, blacklistRoute);
	const itemPreviewUrl =
		item._aPreviewMedia && item._aPreviewMedia._aImages && item._aPreviewMedia._aImages.length > 0
			? item._aPreviewMedia._aImages[0]._sBaseUrl + "/" + item._aPreviewMedia._aImages[0]._sFile
			: "";
	const itemCategoryName = item._aCategory?._sName.replaceAll("Skins", UNCATEGORIZED) || UNCATEGORIZED;
	const itemProfileUrl = item._sProfileUrl || "";
	const itemName = item._sName || "";
	const existingModSourceByName = useMemo(() => {
		return new Map(modList.map((mod) => [mod.name, data[mod.name]?.source || ""]));
	}, [data, modList]);
	const textDataLookup = textData as Record<string, unknown>;
	const blacklistCopy = useMemo(
		() => ({
			label: typeof textDataLookup.Blacklisted === "string" ? textDataLookup.Blacklisted : "Blacklisted",
			warning:
				(typeof textDataLookup.BlacklistedWarning === "string" ? textDataLookup.BlacklistedWarning : undefined) ||
				"This mod is blacklisted. Installed entries with the same source stay marked.",
			add: typeof textDataLookup.BlacklistMod === "string" ? textDataLookup.BlacklistMod : "Blacklist Mod",
			remove:
				typeof textDataLookup.RemoveFromBlacklist === "string"
					? textDataLookup.RemoveFromBlacklist
					: "Remove Blacklist",
			addedToast:
				typeof textDataLookup.BlacklistedAdded === "string"
					? textDataLookup.BlacklistedAdded
					: "Mod added to blacklist.",
			removedToast:
				typeof textDataLookup.BlacklistedRemoved === "string"
					? textDataLookup.BlacklistedRemoved
					: "Mod removed from blacklist.",
		}),
		[textDataLookup]
	);
	const {
		label: blacklistLabel,
		warning: blacklistWarning,
		add: blacklistAdd,
		remove: blacklistRemove,
		addedToast: blacklistAddedToast,
		removedToast: blacklistRemovedToast,
	} = blacklistCopy;
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
	function toggleBlacklist() {
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
			message: nextBlacklisted ? blacklistAddedToast : blacklistRemovedToast,
		});
	}
	async function addToDownloadQueue(file: OnlineDownloadFile) {
		setDownloadList((prev) => {
				//300ms promise await
				// await new Promise(resolve => setTimeout(resolve, 300));
				const dlitem: DownloadItem = {
					status: "pending",
					addon: altPopoverOpen,
					preview: itemPreviewUrl,
					category: itemCategoryName,
					source: itemProfileUrl,
					file: file._sDownloadUrl,
					updated: file._tsDateAdded,
					name: itemName + (altPopoverOpen ? ` - ${file._sFile}` : ""),
					displayName: itemName,
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
					existingModSourceByName.get(dlitem.name) !== undefined && existingModSourceByName.get(dlitem.name) !== dlitem.source
				) {
					dlitem.name = `${itemName} (${count})`;
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
	}
	const addUnifiedDownloadToQueue = (
		downloadOption: { label: string; url: string },
		sourceVariantOverride?: UnifiedSourceVariant | null
	) => {
		if (!effectiveUnifiedCard || !selected) return;

		setDownloadList((prev) => {
			let dlitem: DownloadItem = buildUnifiedDownloadQueueItem({
				card: effectiveUnifiedCard,
				sourceVariant: sourceVariantOverride || activeUnifiedSource,
				downloadOption,
				sourceRoute: selected,
				now: Date.now(),
			});

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
				dlitem = {
					...dlitem,
					name: `${effectiveUnifiedCard.displayName} (${count})`,
				};
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
	};
	useEffect(() => {
		now = Date.now() / 1000;
		const controller = new AbortController();
		if (selected) {
			queueMicrotask(() => {
				setRightSlideOverOpen(true);
				setLoadingComments(false);
				setAboutOpen(true);
				setIgnoreGameCheck(false);
				setLastSelected("about");
				setCommentsOpen(false);
				setUpdateOpen(false);
				setPopoverOpen(false);
				setAltPopoverOpen(false);
				setSelectedUnifiedSourceId((item?._unifiedPreferredSourceId as OnlineSourceId | null) ?? null);
				setUnifiedDetail(null);
			});
			if (!isUnifiedSelected) {
				fetchMod(selected, controller);
			}
		} else {
			queueMicrotask(() => {
				setRightSlideOverOpen(false);
			});
		}
		return () => {
			controller.abort();
		};
	}, [isUnifiedSelected, item?._unifiedPreferredSourceId, selected, setRightSlideOverOpen]);
	const openExternalUrl = useCallback((url: string) => {
		if (!isSafeExternalUrl(url)) return;
		const a = document.createElement("a");
		a.href = url.trim();
		a.target = "_blank";
		a.rel = "noreferrer noopener";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}, []);
	useEffect(() => {
		if (!isUnifiedSelected || !unifiedCard) {
			queueMicrotask(() => {
				setUnifiedDetail(null);
			});
			return;
		}

		let cancelled = false;
		(async () => {
			try {
				const detail = await getUnifiedWwCardDetail(unifiedCard.cardId);
				if (!cancelled) {
					setUnifiedDetail(detail);
				}
			} catch (error) {
				logError("Error fetching unified detail:", error);
				if (!cancelled) {
					setUnifiedDetail(null);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [isUnifiedSelected, unifiedCard, unifiedCard?.cardId]);
	useEffect(() => {
		if (!shouldReuseLegacyGamebananaDetail || !legacyReuseRoute || legacyReuseItem) {
			return;
		}

		const controller = new AbortController();
		fetchMod(legacyReuseRoute, controller).catch((error) => {
			if (!controller.signal.aborted) {
				logError("Error prefetching legacy GameBanana detail:", error);
			}
		});
		return () => {
			controller.abort();
		};
	}, [legacyReuseItem, legacyReuseRoute, shouldReuseLegacyGamebananaDetail]);
	useEffect(() => {
		if (!isDevRuntime || !isUnifiedSelected || !shouldReuseLegacyGamebananaDetail) {
			return;
		}
		logInfo(
			`[IMM][WW unified] legacy reuse active ${JSON.stringify({
				selected,
				legacyReuseRoute,
				activeSourceId: activeUnifiedSource?.sourceId || "",
			})}`
		);
	}, [activeUnifiedSource?.sourceId, isDevRuntime, isUnifiedSelected, legacyReuseRoute, selected, shouldReuseLegacyGamebananaDetail]);
	useEffect(() => {
		if (isUnifiedSelected && unifiedDetailViewState.mode !== "legacy-reuse" && loadingComments) {
			setLoadingComments(false);
		}
	}, [isUnifiedSelected, loadingComments, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (!isUnifiedSelected || unifiedDetailViewState.mode !== "unified-generic") {
			return;
		}

		setCommentsOpen(false);
		if (lastSelected === "comments") {
			setLastSelected("about");
		}
	}, [isUnifiedSelected, lastSelected, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (!isDevRuntime || !isUnifiedSelected) {
			return;
		}

		logInfo(
			`[IMM][WW unified] detail mode ${JSON.stringify({
				mode: unifiedDetailViewState.mode,
				activeSourceId: activeUnifiedSource?.sourceId || "",
				commentsTargetRoute,
			})}`
		);
	}, [activeUnifiedSource?.sourceId, commentsTargetRoute, isDevRuntime, isUnifiedSelected, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "unified-generic" ||
			!activeUnifiedSource
		) {
			return;
		}

		logInfo(
			`[IMM][WW unified] generic fallback ready ${JSON.stringify({
				sourceId: activeUnifiedSource.sourceId,
				description: Boolean(unifiedDetailDescription || unifiedDetailDescriptionHtml),
				links: unifiedDetailLinkRows.length,
				updates: unifiedDetailUpdates.length,
				commentsTargetRoute,
			})}`
		);
	}, [
		activeUnifiedSource,
		commentsTargetRoute,
		isDevRuntime,
		isUnifiedSelected,
		unifiedDetailDescription,
		unifiedDetailDescriptionHtml,
		unifiedDetailLinkRows.length,
		unifiedDetailUpdates.length,
		unifiedDetailViewState.mode,
	]);
	useEffect(() => {
		if (devLegacyReuseAutomationRef.current.route === commentsTargetRoute) {
			return;
		}
		devLegacyReuseAutomationRef.current = {
			route: commentsTargetRoute || "",
			commentsOpened: false,
			loadedMore: false,
			replyCommentId: 0,
		};
	}, [commentsTargetRoute]);
	useEffect(() => {
		if (devUnifiedGenericVerificationRef.current.route === (selected || "")) {
			return;
		}

		devUnifiedGenericVerificationRef.current = {
			route: selected || "",
			switched: false,
			targetSourceId: "",
			visitedSourceIds: [],
			openedSourceCards: [],
		};
		devAfdianAdoptionRef.current = {
			route: selected || "",
			adoptedCardIds: [],
			revokedCardIds: [],
		};
	}, [selected]);
	useEffect(() => {
		if (!isDevRuntime || !shouldReuseLegacyGamebananaDetail || !legacyReuseItem || !commentsTargetRoute) {
			return;
		}

		const automationState = devLegacyReuseAutomationRef.current;
		if (automationState.commentsOpened) {
			return;
		}

		automationState.commentsOpened = true;
		logInfo(
			`[IMM][WW unified] auto-opening comments for legacy reuse ${JSON.stringify({
				commentsTargetRoute,
			})}`
		);
		queueMicrotask(() => {
			setCommentsOpen(true);
			setLastSelected("comments");
			if (!legacyReuseItem?._aComments && !loadingComments) {
				setLoadingComments(true);
			}
		});
	}, [
		commentsTargetRoute,
		isDevRuntime,
		legacyReuseItem,
		loadingComments,
		setLastSelected,
		shouldReuseLegacyGamebananaDetail,
	]);
	useEffect(() => {
		const automationState = devLegacyReuseAutomationRef.current;
		const commentState = commentsTargetItem?._aComments;
		if (
			!isDevRuntime ||
			!shouldReuseLegacyGamebananaDetail ||
			!commentsTargetRoute ||
			!commentState ||
			loadingComments ||
			automationState.loadedMore ||
			commentState.count >= commentState.total
		) {
			return;
		}

		automationState.loadedMore = true;
		logInfo(
			`[IMM][WW unified] auto-loading more comments for legacy reuse ${JSON.stringify({
				commentsTargetRoute,
				count: commentState.count,
				total: commentState.total,
			})}`
		);
		queueMicrotask(() => {
			setLoadingComments(true);
		});
	}, [commentsTargetItem?._aComments, commentsTargetRoute, isDevRuntime, loadingComments, shouldReuseLegacyGamebananaDetail]);
	useEffect(() => {
		if (!isUnifiedSelected || !effectiveUnifiedCard) {
			queueMicrotask(() => {
				setUnifiedRefreshStatuses([]);
			});
			return;
		}

		let cancelled = false;
		(async () => {
			try {
				const statuses = await refreshUnifiedWwSources();
				if (!cancelled) {
					setUnifiedRefreshStatuses(statuses);
				}
			} catch (error) {
				logError("Error fetching unified refresh statuses:", error);
				if (!cancelled) {
					setUnifiedRefreshStatuses([]);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [effectiveUnifiedCard, isUnifiedSelected, effectiveUnifiedCard?.cardId]);
	useEffect(() => {
		if (!isUnifiedSelected || !effectiveUnifiedCard || !unifiedAfdianQuery) {
			queueMicrotask(() => {
				setAfdianCandidates([]);
				setAfdianCandidatesQuery("");
			});
			return;
		}
		if (effectiveUnifiedCard.sources.some((source) => source.sourceId === "afdian")) {
			queueMicrotask(() => {
				setAfdianCandidates([]);
				setAfdianCandidatesQuery("");
			});
			return;
		}

		let cancelled = false;
		queueMicrotask(() => {
			setAfdianCandidates([]);
			setAfdianCandidatesQuery("");
		});
		(async () => {
			try {
				const result = await discoverAfdianCandidates(unifiedAfdianQuery);
				if (!cancelled) {
					logInfo(
						`[IMM][WW unified] afdian candidates ready ${JSON.stringify({
							query: unifiedAfdianQuery,
							count: result.candidates?.length || 0,
						})}`
					);
					setAfdianCandidates(result.candidates || []);
					setAfdianCandidatesQuery(unifiedAfdianQuery);
				}
			} catch (error) {
				logError("Error fetching Afdian candidates:", error);
				if (!cancelled) {
					setAfdianCandidates([]);
					setAfdianCandidatesQuery("");
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [effectiveUnifiedCard, isUnifiedSelected, unifiedAfdianQuery]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "unified-generic" ||
			!effectiveUnifiedCard ||
			effectiveUnifiedCard.sources.some((source) => source.sourceId === "afdian") ||
			!afdianCandidates.length ||
			!areAfdianCandidatesFresh(unifiedAfdianQuery, afdianCandidatesQuery)
		) {
			return;
		}

		const adoptionState = devAfdianAdoptionRef.current;
		if (
			adoptionState.adoptedCardIds.includes(effectiveUnifiedCard.cardId) ||
			adoptionState.revokedCardIds.includes(effectiveUnifiedCard.cardId)
		) {
			return;
		}

		const candidate = findPreferredAfdianCandidate(afdianCandidates, activeUnifiedSource?.author || "");
		if (!candidate) {
			return;
		}

		adoptionState.adoptedCardIds = [...adoptionState.adoptedCardIds, effectiveUnifiedCard.cardId];
		void (async () => {
			try {
				logInfo(
					`[IMM][WW unified] auto-adopting afdian candidate ${JSON.stringify({
						cardId: effectiveUnifiedCard.cardId,
						detailUrl: candidate.detailUrl,
					})}`
				);
				const detail = await attachAfdianCandidateToUnifiedCard(effectiveUnifiedCard.cardId, candidate.detailUrl);
				applyAdoptedAfdianDetail(detail, candidate.detailUrl);
			} catch (error) {
				logError("Error auto adopting Afdian candidate:", error);
			}
		})();
	}, [
		activeUnifiedSource?.author,
		afdianCandidates,
		afdianCandidatesQuery,
		applyAdoptedAfdianDetail,
		effectiveUnifiedCard,
		isDevRuntime,
		isUnifiedSelected,
		unifiedAfdianQuery,
		unifiedDetailViewState.mode,
	]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "unified-generic" ||
			!effectiveUnifiedCard ||
			activeUnifiedSource?.sourceId !== "afdian"
		) {
			return;
		}

		const adoptionState = devAfdianAdoptionRef.current;
		if (adoptionState.revokedCardIds.includes(effectiveUnifiedCard.cardId)) {
			return;
		}

		adoptionState.revokedCardIds = [...adoptionState.revokedCardIds, effectiveUnifiedCard.cardId];
		void (async () => {
			try {
				logInfo(
					`[IMM][WW unified] auto-detaching afdian source ${JSON.stringify({
						cardId: effectiveUnifiedCard.cardId,
						activeSourceId: activeUnifiedSource.sourceId,
					})}`
				);
				const detail = await detachAfdianSourceFromUnifiedCard(effectiveUnifiedCard.cardId);
				applyDetachedAfdianDetail(detail);
			} catch (error) {
				logError("Error auto detaching Afdian source:", error);
			}
		})();
	}, [activeUnifiedSource?.sourceId, applyDetachedAfdianDetail, effectiveUnifiedCard, isDevRuntime, isUnifiedSelected, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (type != "Install" && item?._sProfileUrl) {
			if (installedItem?.name) {
				setData((prev: ModDataObj) => ({
					...prev,
					[installedItem.name]: {
						...prev[installedItem.name],
						viewedAt: now * 1000,
					},
				}));
			}
			refreshModList().then((list) => {
				setModList(list);
			});
			saveConfigs();
		}
	}, [installedItem?.name, item, selected, setData, setModList, type]);
	useEffect(() => {
		if (item?._aFiles && gameMatched && fileToDl) {
			const file = item._aFiles.find((f: OnlineDownloadFile) => f._idRow == fileToDl);
			if (file) {
				setDownloadList((prev) => {
					const dlitem: DownloadItem = {
						status: "pending",
						addon: altPopoverOpen,
						preview: itemPreviewUrl,
						category: itemCategoryName,
						source: itemProfileUrl,
						file: file._sDownloadUrl,
						updated: file._tsDateAdded,
						name: itemName + (altPopoverOpen ? ` - ${file._sFile}` : ""),
						displayName: itemName,
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
						(existingModSourceByName.get(dlitem.name) !== undefined && existingModSourceByName.get(dlitem.name) !== dlitem.source)
					) {
						dlitem.name = `${itemName} (${count})`;
						count++;
					}
					return {
						downloading: prev?.downloading || [],
						completed: prev?.completed || [],
						queue: [...(prev?.queue || []), dlitem],
						extracting: prev?.extracting || [],
						failed: prev?.failed || [],
					};
				});
				addToast({ type: "success", message: textData._Toasts.FileAdded });
				setFileToDl("");
			}
		}
	}, [
		altPopoverOpen,
		existingModSourceByName,
		fileToDl,
		game,
		gameMatched,
		item?._aFiles,
		itemCategoryName,
		itemName,
		itemPreviewUrl,
		itemProfileUrl,
		setDownloadList,
		setFileToDl,
		textData._Toasts.FileAdded,
	]);
	const getComments = useCallback(
		async (signal: AbortSignal) => {
			try {
				if (commentsTargetRoute && onlineData[commentsTargetRoute]) {
					const item = getSelectedOnlineItem(onlineData, commentsTargetRoute);
					const currentComments = item._aComments || {
						total: 0,
						count: 0,
						data: {},
						list: [],
					};
					if (isDevRuntime) {
						logInfo(
							`[IMM][WW unified] fetching comments via route ${JSON.stringify({
								commentsTargetRoute,
								page: Math.floor(currentComments.count / 15) + 1,
							})}`
						);
					}
					const data = await apiClient.comments(commentsTargetRoute, Math.floor(currentComments.count / 15) + 1, signal);
					if (!data || signal.aborted) return;
					const records = ((data._aRecords || []) as OnlineComment[]).filter((comment: OnlineComment) => comment._aPoster);
					const nextComments = {
						...currentComments,
						total: data._aMetadata._nRecordCount,
						count: data._aMetadata._bIsComplete
							? data._aMetadata._nRecordCount
							: currentComments.count + data._aMetadata._nPerpage,
						data: {
							...currentComments.data,
							...Object.fromEntries(
								records.map((comment: OnlineComment) => [
									comment._idRow,
									{
										...comment,
										_aLabels: new Set(comment._aLabels || []),
									},
								])
							),
						},
						list: [...currentComments.list, ...records.map((comment: OnlineComment) => comment._idRow)],
					};
					setOnlineData((prev) => ({
						...prev,
						[commentsTargetRoute]: {
							...getSelectedOnlineItem(prev, commentsTargetRoute),
							_aComments: nextComments,
						},
					}) as OnlineData);
				}
			} catch (e) {
				logError("Error fetching comments:", e);
			}
			setLoadingComments(false);
		},
		[commentsTargetRoute, isDevRuntime, onlineData, setOnlineData]
	);
	const loadReplies = useCallback(
		async (comment: OnlineComment) => {
			if (isDevRuntime) {
				logInfo(
					`[IMM][WW unified] fetching nested comments ${JSON.stringify({
						commentsTargetRoute,
						commentId: comment._idRow,
					})}`
				);
			}
			const children = (((await apiClient.nestedcomments(String(comment._idRow)))?._aRecords || []) as OnlineComment[]).filter(
				(childComment: OnlineComment) => childComment._aPoster
			);
			setOnlineData((prev) => {
				const prevItem = getSelectedOnlineItem(prev, commentsTargetRoute);
				return {
					...prev,
					[commentsTargetRoute]: {
						...prevItem,
						_aComments: {
							...prevItem._aComments,
							data: {
								...prevItem._aComments?.data,
								[comment._idRow]: {
									...prevItem._aComments?.data?.[comment._idRow],
									children: children.map((childComment: OnlineComment) => childComment._idRow),
								},
								...Object.fromEntries(
									children.map((childComment: OnlineComment) => [
										childComment._idRow,
										{
											...childComment,
											_aLabels: new Set(childComment._aLabels || []),
										},
									])
								),
							},
						},
					},
				} as OnlineData;
			});
		},
		[commentsTargetRoute, isDevRuntime, setOnlineData]
	);
	const viewReplies = useCallback(
		async (e: React.MouseEvent<HTMLButtonElement>, comment: OnlineComment) => {
			e.currentTarget.disabled = true;
			try {
				await loadReplies(comment);
			} catch (err) {
				logError("Error fetching replies:", err);
				e.currentTarget.disabled = false;
			}
		},
		[loadReplies]
	);
	useEffect(() => {
		const automationState = devLegacyReuseAutomationRef.current;
		const commentState = commentsTargetItem?._aComments;
		if (
			!isDevRuntime ||
			!shouldReuseLegacyGamebananaDetail ||
			!commentsTargetRoute ||
			!commentState?.list?.length ||
			loadingComments
		) {
			return;
		}

		const nextReplyComment = commentState.list
			.map((commentId: number) => commentState.data?.[commentId])
			.find((comment: OnlineComment | undefined) => comment?._nReplyCount && !(comment.children && comment.children.length > 0));
		if (!nextReplyComment || automationState.replyCommentId) {
			return;
		}

		automationState.replyCommentId = nextReplyComment._idRow;
		logInfo(
			`[IMM][WW unified] auto-loading nested comments for legacy reuse ${JSON.stringify({
				commentsTargetRoute,
				commentId: nextReplyComment._idRow,
			})}`
		);
		void loadReplies(nextReplyComment).catch((error) => {
			logError("Error auto fetching replies:", error);
			if (devLegacyReuseAutomationRef.current.route === commentsTargetRoute) {
				devLegacyReuseAutomationRef.current.replyCommentId = 0;
			}
		});
	}, [
		commentsTargetItem?._aComments,
		commentsTargetRoute,
		isDevRuntime,
		loadReplies,
		loadingComments,
		shouldReuseLegacyGamebananaDetail,
	]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "legacy-reuse" ||
			!effectiveUnifiedCard ||
			loadingComments
		) {
			return;
		}

		const verificationState = devUnifiedGenericVerificationRef.current;
		const fallbackSourceId =
			verificationState.targetSourceId ||
			findUnifiedGenericFallbackSourceId(effectiveUnifiedCard, "gamebanana", verificationState.visitedSourceIds);
		if (!fallbackSourceId || verificationState.switched) {
			return;
		}

		const automationState = devLegacyReuseAutomationRef.current;
		const commentState = commentsTargetItem?._aComments;
		if (!automationState.loadedMore || !automationState.replyCommentId || !commentState?.count) {
			return;
		}

		verificationState.targetSourceId = fallbackSourceId;
		verificationState.switched = true;
		verificationState.visitedSourceIds = Array.from(
			new Set<OnlineSourceId>([...verificationState.visitedSourceIds, fallbackSourceId])
		);
		logInfo(
			`[IMM][WW unified] auto-switching to generic fallback ${JSON.stringify({
				fromSourceId: activeUnifiedSource?.sourceId || "",
				toSourceId: fallbackSourceId,
				selected,
			})}`
		);
		setSelectedUnifiedSourceId(fallbackSourceId);
	}, [
		activeUnifiedSource?.sourceId,
		commentsTargetItem?._aComments,
		effectiveUnifiedCard,
		isDevRuntime,
		isUnifiedSelected,
		loadingComments,
		selected,
		unifiedDetailViewState.mode,
	]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "unified-generic" ||
			!effectiveUnifiedCard ||
			!activeUnifiedSource
		) {
			return;
		}

		const verificationState = devUnifiedGenericVerificationRef.current;
		if (!verificationState.visitedSourceIds.includes(activeUnifiedSource.sourceId)) {
			verificationState.visitedSourceIds = [...verificationState.visitedSourceIds, activeUnifiedSource.sourceId];
		}
		if (verificationState.targetSourceId === activeUnifiedSource.sourceId) {
			verificationState.targetSourceId = "";
			verificationState.switched = false;
		}
	}, [activeUnifiedSource, effectiveUnifiedCard, isDevRuntime, isUnifiedSelected, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "unified-generic" ||
			!activeUnifiedSource ||
			activeUnifiedSource.sourceId !== "hui"
		) {
			return;
		}

		const verificationState = devUnifiedGenericVerificationRef.current;
		if (verificationState.openedSourceCards.includes("keke")) {
			return;
		}

		const sourceItem = findUnifiedListCardForSource(
			getUnifiedCacheItems(onlineData, unifiedCacheKey),
			"keke"
		);
		if (!sourceItem) {
			return;
		}
		const route = sourceItem._sProfileUrl;

		verificationState.openedSourceCards = [...verificationState.openedSourceCards, "keke"];
		logInfo(
			`[IMM][WW unified] auto-opening standalone generic card ${JSON.stringify({
				fromSourceId: activeUnifiedSource.sourceId,
				toCardRoute: route,
				targetSourceId: "keke",
			})}`
		);
		queueMicrotask(() => {
			setSelectedUnifiedSourceId(null);
			setOnlineData((prev) => ({
				...prev,
				[route]: sourceItem,
			}));
			setOnlineSelected(route);
		});
	}, [activeUnifiedSource, isDevRuntime, isUnifiedSelected, onlineData, setOnlineData, setOnlineSelected, unifiedCacheKey, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (
			!isDevRuntime ||
			!isUnifiedSelected ||
			unifiedDetailViewState.mode !== "unified-generic" ||
			!effectiveUnifiedCard ||
			!activeUnifiedSource ||
			activeUnifiedSource.sourceId === "gamebanana"
		) {
			return;
		}

		const verificationState = devUnifiedGenericVerificationRef.current;
		const nextFallbackSourceId = findUnifiedGenericFallbackSourceId(
			effectiveUnifiedCard,
			"gamebanana",
			verificationState.visitedSourceIds
		);
		if (!nextFallbackSourceId || verificationState.switched) {
			return;
		}

		verificationState.targetSourceId = nextFallbackSourceId;
		verificationState.switched = true;
		verificationState.visitedSourceIds = Array.from(
			new Set<OnlineSourceId>([...verificationState.visitedSourceIds, nextFallbackSourceId])
		);
		logInfo(
			`[IMM][WW unified] auto-switching to next generic fallback ${JSON.stringify({
				fromSourceId: activeUnifiedSource.sourceId,
				toSourceId: nextFallbackSourceId,
				selected,
			})}`
		);
		setSelectedUnifiedSourceId(nextFallbackSourceId);
	}, [activeUnifiedSource, effectiveUnifiedCard, isDevRuntime, isUnifiedSelected, selected, unifiedDetailViewState.mode]);
	useEffect(() => {
		if (loadingComments && commentsTargetRoute) {
			if (commentsFetchInFlightRef.current) {
				return;
			}
			commentsFetchInFlightRef.current = true;
			const controller = new AbortController();
			void getComments(controller.signal).finally(() => {
				commentsFetchInFlightRef.current = false;
			});
			return () => {
				controller.abort();
			};
		}
		return () => {};
	}, [commentsTargetRoute, getComments, loadingComments]);
	const popoverContent = item?._aFiles?.map((file: OnlineDownloadFile) => (
		<Button
			key={`file-${file._sFile}-${file._idRow || file._sDownloadUrl}`}
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
							<TooltipTrigger asChild>
								<span className="inline-flex items-center justify-center">
									<InfoIcon />
								</span>
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
	function recursiveComments(detailItem: LegacyDetailItem, list: number[], depth = 0): React.JSX.Element {
		return (
			<div className="flex flex-col w-full gap-4">
				{list.map((commentId: number, index: number) => {
					const comment = detailItem?._aComments?.data?.[commentId];
					const isSubmitter =
						comment?._aLabels instanceof Set
							? comment._aLabels.has("Submitter")
							: Array.isArray(comment?._aLabels)
								? comment._aLabels.includes("Submitter")
								: false;
					if (!comment) return null;
					return (
						<div key={`comment-row-${commentId}`}>
							{index > 0 && <hr />}
							<div
								key={commentId}
								className="flex select-none flex-col bg-input/20 rounded gap-2"
								onDoubleClick={(e) => {
									const lastChild = e.currentTarget.lastElementChild as HTMLDivElement;
									if (lastChild) {
										if (lastChild.style.height == "0px") lastChild.style.height = "auto";
										else lastChild.style.height = "0px";
									}
								}}
							>
								<div className={`flex items-center rounded p-1 pt-2 pl-2 gap-2 ${isSubmitter && "bg-accent/10"}`}>
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
									{isSubmitter && (
										<span className="text-xs rounded px-1 bg-accent text-background">{"Submitter"}</span>
									)}
									<span className="text-xs text-gray-400">
										{getTimeDifference(now, comment._tsDateModified || comment._tsDateAdded || 0)}
									</span>
									{(comment._iPinLevel || 0) > 0 && <PinIcon className="h-4 fill-accent stroke-accent" />}
									{comment._aPoster?._sSigUrl && (
										<img src={comment._aPoster?._sSigUrl} className="max-h-4" alt="User Pic" />
									)}
									{comment._aStamps?.map((stamp: OnlineStamp, stampIndex: number) => (
										<span
											key={`stamp-${comment._idRow}-${stamp._sTitle}-${stampIndex}`}
											className={`text-xs rounded px-1 ${typeToBg[(stamp._sCategory as keyof typeof typeToBg) || "neutral"] || typeToBg.neutral} flex items-center justify-center text-background`}
										>
											<StampIcons className={" max-h-4"} title={stamp._sTitle} />
											{stamp._sTitle} {stamp._nCount > 1 ? `x${stamp._nCount}` : ""}
										</span>
									))}
								</div>
								<div className="w-full flex flex-col gap-4 h-auto overflow-hidden pl-14 pb-3 pr-3">
									<SafeHtml html={comment._sText || ""} className="w-full select-text duration-200 font-sans " />
									{(comment.children?.length || 0) > 0 && recursiveComments(detailItem, comment.children || [], depth + 1)}
									{(comment._nReplyCount || 0) > 0 && !comment.children && (
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
						</div>
					);
				})}
			</div>
		);
	}
	function renderLegacyAboutUpdatesComments(detailItem: LegacyDetailItem | null) {
		if (!detailItem) {
			return (
				<div className="flex items-center justify-center w-full p-4 text-accent">
					<LoaderIcon className="animate-spin" />
				</div>
			);
		}
		return (
			<>
				{detailItem._sText && (
					<Collapsible
						key={detailItem._sName + "abt"}
						id="about"
						className="w-full px-2 pb-3"
						open={aboutOpen}
						onOpenChange={(open) => {
							setAboutOpen(open);
							if (open) setLastSelected("about");
						}}
					>
						<CollapsibleTrigger asChild>
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
							<SafeHtml html={detailItem._sText} className="w-full font-sans" />
						</CollapsibleContent>
					</Collapsible>
				)}
				{Boolean(detailItem._eUpdate) && (
					<Collapsible
						key={detailItem._sName + "upd"}
						id="updates"
						className=" w-full px-2 pb-3"
						open={updateOpen}
						onOpenChange={(open) => {
							setUpdateOpen(open);
							if (open) setLastSelected("update");
						}}
					>
						<CollapsibleTrigger asChild>
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
							{detailItem._aUpdates &&
								detailItem._aUpdates.length > 0 &&
								detailItem._aUpdates.map((itm: LegacyUpdateItem, index: number) => (
									<>
										{index > 0 && <hr className="border-accent/50" />}

										<div className="flex rounded flex-col gap-2 bg-input/10 p-2">
											<div className="text-accent flex items-center justify-between pb-4 border-b">
												{itm._sName}
												<label className="flex flex-col text-xs text-gray-300">
													{" "}
													<label>{itm._sVersion}</label>{" "}
													<label className=" text-cyan-200">{getTimeDifference(now, itm._sDate || 0)}</label>
												</label>
											</div>
											<div className=" flex flex-col gap-2">
												{itm._aChangeLog &&
													itm._aChangeLog.map((changeItem: LegacyChangeLogItem, index: number) => (
														<div key={index} className="flex items-center gap-2">
															<div className="min-w-2 min-h-2 self-start mt-1.75 bg-accent bgaccent   rounded-full" />
															<label className=" text-cyan-50 font-sans text-sm">
																{changeItem.text}- [{changeItem.cat}]
															</label>
														</div>
													))}
											</div>
											{itm._sText && (
												<SafeHtml html={itm._sText} className="w-full font-sans" />
											)}
										</div>
									</>
								))}
						</CollapsibleContent>
					</Collapsible>
				)}
				<Collapsible
					key={detailItem._sName + "cmt"}
					id="comments"
					className="w-full px-2 pt-1 pb-1"
					open={commentsOpen}
					onOpenChange={(open) => {
						setCommentsOpen(open);
						setLastSelected("comments");
						if (open && !commentsTargetItem?._aComments) {
							setLoadingComments(true);
						}
					}}
				>
					<CollapsibleTrigger asChild>
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
						{commentsTargetItem?._aComments && commentsTargetItem._aComments.total > 0
							? recursiveComments(commentsTargetItem, commentsTargetItem._aComments.list, 0)
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
							commentsTargetItem?._aComments &&
							commentsTargetItem._aComments.count < commentsTargetItem._aComments.total && (
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
					{detailItem._sText && (
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
					{Boolean(detailItem._eUpdate) && (
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
					<Button
						className={
							"w flex justify-between bg-accent text-background " +
							(lastSelected == "comments"
								? "hover:brightness-125"
								: "bg-input/50 text-accent hover:text-accent hover:bg-input")
						}
						onClick={() => {
							setCommentsOpen((prev) => {
								if (!prev && !commentsTargetItem?._aComments) {
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
				</div>
			</>
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
						) : item?._sModelName === "UnifiedCard" ? (
							<motion.div
								key={"loaded-unified-" + selected}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
								className="flex flex-col items-center w-full h-full overflow-hidden duration-300"
							>
								<div className="text-accent min-h-16 flex items-center justify-start w-full gap-3 px-3 border-b">
									<div className="min-w-fit trs bg-button zzz-border flex items-center gap-2 p-2 rounded-md">
										<span className="ctrs">{item._aRootCategory?._sName || "Other"}</span>
									</div>

									<Label key={item._sName} className="w-full text-xl text-center">
										{item._sName}
									</Label>

									<div className="min-w-fit trs bg-button zzz-border flex items-center gap-2 p-2 rounded-md">
										<span className="ctrs">{effectiveUnifiedCard?.primarySourceId || "unified"}</span>
									</div>
								</div>

								<div className="flex flex-col w-full h-full overflow-y-auto pb-6">
									<div className="min-h-fit flex flex-col items-center w-full max-h-full gap-1 px-2 mt-2 mb-3 overflow-hidden pointer-events-none">
										{unifiedPreviewImages.length > 0 && <Carousel data={unifiedPreviewImages} />}
									</div>

									<div className="px-4 pb-4 flex flex-col gap-3">
										<div className="rounded-lg border bg-input/20 p-3">
											<div className="text-sm font-medium">统一来源卡片</div>
											<div className="mt-2 text-sm text-muted-foreground break-words">
												主来源：{effectiveUnifiedCard?.primarySourceId || "unknown"}
											</div>
											<div className="mt-1 text-sm text-muted-foreground break-words">
												当前来源：{activeUnifiedSource?.sourceId || effectiveUnifiedCard?.primarySourceId || "unknown"}
											</div>
											<div className="mt-1 text-sm text-muted-foreground break-words">
												作者：{activeUnifiedSource?.author || item._aSubmitter?._sName || "未知"}
											</div>
											<div className="mt-1 text-sm text-muted-foreground break-words">
												去重摘要：{unifiedDuplicateSummary}
											</div>
											<div className="mt-1 text-sm text-muted-foreground break-words">
												详情能力：{unifiedDetailCapabilityLabels.join(" / ")}
											</div>
											{unifiedDetail?.primarySourceCanReuseLegacyDetail && (
												<div className="mt-1 text-sm text-muted-foreground break-words">
													旧详情复用：当前主来源可复用旧 GameBanana 详情结构
												</div>
											)}
											{activeUnifiedSource?.summary && (
												<div className="mt-2 rounded-md border bg-background/40 p-3 text-sm text-muted-foreground break-words">
													{activeUnifiedSource.summary}
												</div>
											)}
											<div className="mt-3 flex flex-wrap gap-2">
												{(effectiveUnifiedCard?.sources || []).map((source: UnifiedSourceVariant) => (
													<Button
														key={`switch-${source.sourceId}:${source.sourceModId}`}
														variant={activeUnifiedSource?.sourceId === source.sourceId ? "default" : "outline"}
														className="min-w-24"
														onClick={() => {
															setSelectedUnifiedSourceId(source.sourceId);
														}}
													>
														{source.sourceId}
													</Button>
												))}
											</div>
											<div className="mt-3 flex flex-wrap gap-2">
												<Button
													className="min-w-24"
													onClick={() => {
														openExternalUrl(activeUnifiedSource?.detailUrl || "");
													}}
													disabled={!activeUnifiedSource?.detailUrl}
												>
													打开当前来源
												</Button>
												{unifiedDetailLinkRows
													.filter((link) => link.url !== activeUnifiedSource?.detailUrl)
													.map((link) => (
														<Button
															key={`${link.label}:${link.url}`}
															variant="outline"
															className="min-w-24"
															onClick={() => {
																openExternalUrl(link.url);
															}}
														>
															{link.label}
														</Button>
													))}
												{activeUnifiedDownloads.map((download) => (
													<Button
														key={`${download.label}:${download.url}`}
														variant="outline"
														className="min-w-24"
														onClick={() => {
															addUnifiedDownloadToQueue(download);
														}}
													>
														{download.label}
													</Button>
												))}
											</div>
										</div>

										{unifiedDetailOverviewRows.length > 0 && (
											<div className="rounded-lg border bg-input/20 p-3">
												<div className="text-sm font-medium">详情概览</div>
												<div className="mt-3 grid grid-cols-1 gap-2">
													{unifiedDetailOverviewRows.map((row) => (
														<div key={`overview-${row.label}`} className="rounded-md border bg-background/40 p-3 text-sm">
															<div className="text-xs text-muted-foreground">{row.label}</div>
															<div className="mt-1 font-medium break-words">{row.value}</div>
														</div>
													))}
												</div>
											</div>
										)}

										{shouldReuseLegacyGamebananaDetail ? (
											<div id="container" className="flex flex-col w-full pb-2 mb-6 overflow-hidden">
												{renderLegacyAboutUpdatesComments(legacyReuseItem)}
											</div>
										) : (
											(unifiedDetailDescriptionHtml || unifiedDetailDescription) && (
											<div className="rounded-lg border bg-input/20 p-3">
												<div className="text-sm font-medium">详情说明</div>
												<div className="mt-3 rounded-md border bg-background/40 p-3 text-sm">
													{unifiedDetailDescriptionHtml ? (
														<SafeHtml html={unifiedDetailDescriptionHtml} className="font-sans break-words" />
													) : (
														<div className="break-words whitespace-pre-wrap">{unifiedDetailDescription}</div>
													)}
												</div>
											</div>
											)
										)}

										{unifiedDetailSourceNote && (
											<div className="rounded-lg border bg-input/20 p-3">
												<div className="text-sm font-medium">来源备注</div>
												<SafeHtml
													html={unifiedDetailSourceNote}
													className="mt-3 rounded-md border bg-background/40 p-3 text-sm font-sans break-words"
												/>
											</div>
										)}

										{unifiedDetailLinkRows.length > 0 && (
											<div className="rounded-lg border bg-input/20 p-3">
												<div className="text-sm font-medium">详情链接</div>
												<div className="mt-3 flex flex-wrap gap-2">
													{unifiedDetailLinkRows.map((link) => (
														<Button
															key={`detail-link-${link.label}:${link.url}`}
															variant="outline"
															className="min-w-24"
															onClick={() => {
																openExternalUrl(link.url);
															}}
														>
															{link.label}
														</Button>
													))}
												</div>
											</div>
										)}

										{!shouldReuseLegacyGamebananaDetail && unifiedDetailUpdates.length > 0 && (
											<div className="rounded-lg border bg-input/20 p-3">
												<div className="text-sm font-medium">来源更新</div>
												<div className="mt-3 flex flex-col gap-2">
													{unifiedDetailUpdates.map((update, index) => (
														<div
															key={`detail-update-${update.title}-${update.publishedAt || index}`}
															className="rounded-md border bg-background/40 p-3 text-sm"
														>
															<div className="flex items-center justify-between gap-3">
																<div className="font-medium break-words">{update.title}</div>
																<div className="text-xs text-muted-foreground">{update.version || "未标版本"}</div>
															</div>
															{update.publishedAt && (
																<div className="mt-1 text-xs text-muted-foreground break-words">
																	{update.publishedAt}
																</div>
															)}
															{update.summary && (
																<div className="mt-2 text-sm text-muted-foreground break-words">
																	{update.summary}
																</div>
															)}
															{update.url && (
																<Button
																	variant="outline"
																	className="mt-3 min-w-24"
																	onClick={() => {
																		openExternalUrl(update.url);
																	}}
																>
																	打开更新
																</Button>
															)}
														</div>
													))}
												</div>
											</div>
										)}

										<div className="rounded-lg border bg-input/20 p-3">
											<div className="flex items-center justify-between gap-2">
												<div className="text-sm font-medium">来源刷新状态</div>
												<Button
													variant="outline"
													className="h-8 px-2"
													disabled={refreshingUnifiedSourceId !== null}
													onClick={() => {
														void refreshUnifiedCache("all");
													}}
												>
													{refreshingUnifiedSourceId === "all" ? (
														<LoaderIcon className="h-4 w-4 animate-spin" />
													) : (
														<Redo2Icon className="h-4 w-4" />
													)}
													<span className="ml-1 text-xs">刷新</span>
												</Button>
											</div>
											<div className="mt-3 flex flex-col gap-2">
												{unifiedRefreshRows.map((row) => (
													<div
														key={`status-${row.sourceId}`}
														className="rounded-md border bg-background/40 p-3 text-sm"
													>
														<div className="flex items-center justify-between gap-3">
															<div className="font-medium break-words">
																{row.sourceId}
																{row.isPrimary ? " · 主来源" : ""}
															</div>
															<div className="flex items-center gap-2">
																<div className="text-xs text-muted-foreground">{row.status}</div>
																<Button
																	variant="outline"
																	className="h-7 px-2"
																	disabled={refreshingUnifiedSourceId !== null}
																	onClick={() => {
																		void refreshUnifiedCache(row.sourceId as OnlineSourceId);
																	}}
																>
																	{refreshingUnifiedSourceId === row.sourceId ? (
																		<LoaderIcon className="h-3.5 w-3.5 animate-spin" />
																	) : (
																		<Redo2Icon className="h-3.5 w-3.5" />
																	)}
																</Button>
															</div>
														</div>
														<div className="mt-1 text-xs text-muted-foreground break-words">{row.title}</div>
														{row.message && (
															<div className="mt-1 text-xs text-muted-foreground break-words">{row.message}</div>
														)}
													</div>
												))}
											</div>
										</div>

										<div className="rounded-lg border bg-input/20 p-3">
											<div className="text-sm font-medium">去重明细</div>
											<div className="mt-3 flex flex-col gap-2">
												{unifiedDuplicateEvidenceRows.length > 0 ? (
													unifiedDuplicateEvidenceRows.map((row) => (
														<div key={`evidence-${row.label}`} className="rounded-md border bg-background/40 p-3 text-sm">
															<div className="text-xs text-muted-foreground">{row.label}</div>
															<div className="mt-1 font-medium break-words">{row.value}</div>
														</div>
													))
												) : (
													<div className="rounded-md border bg-background/40 p-3 text-sm text-muted-foreground">
														当前卡片没有更细的去重证据。
													</div>
												)}
											</div>
										</div>

										<div className="rounded-lg border bg-input/20 p-3">
											<div className="text-sm font-medium">来源列表</div>
											<div className="mt-3 flex flex-col gap-2">
												{(effectiveUnifiedCard?.sources || []).map((source: UnifiedSourceVariant) => (
													<div key={`${source.sourceId}:${source.sourceModId}`} className="rounded-md border bg-background/40 p-3">
														<div className="flex items-center justify-between gap-2">
															<div className="font-medium break-words">{source.title}</div>
															<div className="text-xs text-muted-foreground">{source.sourceId}</div>
														</div>
														<div className="mt-1 text-xs text-muted-foreground break-words">
															作者：{source.author || "未知"}
														</div>
														<div className="mt-1 text-xs text-muted-foreground break-words">
															更新时间：{source.rawUpdatedAt || "未知"}
														</div>
														<div className="mt-3 flex gap-2">
															<Button
																className="min-w-24"
																onClick={() => {
																	setSelectedUnifiedSourceId(source.sourceId);
																}}
															>
																设为当前来源
															</Button>
															<Button
																variant="outline"
																className="min-w-24"
																onClick={() => {
																	openExternalUrl(source.detailUrl);
																}}
															>
																打开来源
															</Button>
															{source.downloadOptions?.[0]?.url && (
																<Button
																	variant="outline"
																	className="min-w-24"
																	onClick={() => {
																		addUnifiedDownloadToQueue(source.downloadOptions[0], source);
																	}}
																>
																	下载入口
																</Button>
															)}
															{source.sourceId === "afdian" && (
																<Button
																	variant="outline"
																	className="min-w-24"
																	onClick={async () => {
																		if (!effectiveUnifiedCard) return;
																		try {
																			const detail = await detachAfdianSourceFromUnifiedCard(
																				effectiveUnifiedCard.cardId
																			);
																			applyDetachedAfdianDetail(detail);
																			addToast({
																				type: "success",
																				message: "已撤销爱发电来源采纳",
																			});
																		} catch (error) {
																			logError("Error detaching Afdian source:", error);
																			addToast({
																				type: "error",
																				message: "撤销爱发电来源失败",
																			});
																		}
																	}}
																>
																	撤销采纳
																</Button>
															)}
														</div>
													</div>
												))}
											</div>
										</div>

										{afdianCandidates.length > 0 && (
											<div className="rounded-lg border bg-input/20 p-3">
												<div className="text-sm font-medium">爱发电候选</div>
												<div className="mt-1 text-xs text-muted-foreground break-words">
													查询词：{unifiedAfdianQuery}
												</div>
												<div className="mt-3 flex flex-col gap-2">
													{afdianCandidates.map((candidate, index) => (
														<div
															key={`afdian-${candidate.detailUrl}-${index}`}
															className="rounded-md border bg-background/40 p-3 text-sm"
														>
															<div className="font-medium break-words">{candidate.title}</div>
															<div className="mt-1 text-xs text-muted-foreground break-words">
																作者：{candidate.author || "未知"}
															</div>
															<div className="mt-3 flex gap-2">
																<Button
																	variant="outline"
																	className="min-w-24"
																	onClick={() => {
																		openExternalUrl(candidate.detailUrl);
																	}}
																>
																	打开候选
																</Button>
																<Button
																	className="min-w-24"
																	onClick={async () => {
																	if (!effectiveUnifiedCard) return;
																	try {
																		const detail = await attachAfdianCandidateToUnifiedCard(
																			effectiveUnifiedCard.cardId,
																			candidate.detailUrl
																		);
																		applyAdoptedAfdianDetail(detail, candidate.detailUrl);
																		addToast({
																			type: "success",
																			message: "已采纳爱发电候选来源",
																			});
																		} catch (error) {
																			logError("Error adopting Afdian candidate:", error);
																			addToast({
																				type: "error",
																				message: "采纳爱发电候选失败",
																			});
																		}
																	}}
																>
																	采纳为来源
																</Button>
															</div>
														</div>
													))}
												</div>
											</div>
										)}
									</div>
								</div>
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
										rel="noreferrer noopener"
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
													if (!isSafeExternalUrl(item._sProfileUrl || "")) return;
													const a = document.createElement("a");
													a.href = item._sProfileUrl || "";
													a.target = "_blank";
													a.rel = "noreferrer noopener";
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
													<span className="font-medium">{blacklistLabel}</span>
													<span className="text-xs opacity-90">{blacklistWarning}</span>
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
											{renderLegacyAboutUpdatesComments(item)}
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
												].map((children, index) => (
													<label
														key={`legacy-stat-${index}`}
														className="zzz-fg-text text-accent flex flex-col items-center justify-center"
													>
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
													{isBlacklisted ? blacklistRemove : blacklistAdd}
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
											{Object.prototype.hasOwnProperty.call(GAME_GB_IDS, item._aGame._idRow) && (
												<Button
													onClick={() => {
														const game = GAME_GB_IDS[item._aGame._idRow];
														if (game) {
															const url = item._sProfileUrl;
															addToast({
																message: textData._Toasts.SwitchGame.replace("<game/>", item._aGame._sName),
															});
															sessionStorage.setItem("imm-deep-link-game", game);
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
