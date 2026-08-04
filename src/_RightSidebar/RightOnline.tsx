import { addToast } from "@/_Toaster/ToastProvider";
import { RemoteImage } from "@/components/RemoteImage";
import { SafeHtml } from "@/components/SafeHtml";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { getGameBananaProvider, isGameBananaAbortError } from "@/utils/api";
import { GAME_GB_IDS, UNCATEGORIZED } from "@/utils/consts";
import { refreshModList, saveConfigs, saveGameBananaBinding } from "@/utils/filesys";
import {
	createGameBananaBinding,
	findGameBananaBindingConflicts,
	rankLocalBindingCandidates,
} from "@/utils/modBinding";
import type {
	DownloadItem,
	DownloadList,
	GameBananaSelectedFile,
	Mod,
	ModDataObj,
	OnlineData,
	OnlineMod,
	OnlineModCategory,
	OnlineModPreviewMedia,
} from "@/utils/types";
import {
	formatSize,
	getImageUrl,
	getTimeDifference,
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
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	BanIcon,
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	DiscIcon,
	DownloadIcon,
	ExternalLinkIcon,
	LinkIcon,
	LoaderIcon,
	MessageSquareIcon,
	RefreshCwIcon,
	ThumbsUpIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import Carousel from "./components/Carousel";

interface OnlineDownloadFile {
	_idRow?: number | string;
	_sDownloadUrl: string;
	_tsDateAdded: number;
	_sFile: string;
	_sDescription?: string;
	_sAnalysisState?: string;
	_sAvState?: string;
	_sAvResult?: string;
	_aAnalysisWarnings?: { contains_exe?: boolean };
	_nFilesize?: number;
	_nDownloadCount?: number;
	_sMd5Checksum?: string;
}

interface OnlineUpdate {
	_sName?: string;
	_sVersion?: string;
	_sText?: string;
	_tsDateAdded?: number;
	_tsDateModified?: number;
	_aChangeLog?: Array<{ text?: string; cat?: string }>;
}

interface OnlineComment {
	_idRow: number;
	_aPoster?: {
		_sAvatarUrl?: string;
		_sName?: string;
		_sSigUrl?: string;
	};
	_aLabels?: string[];
	_aStamps?: Array<{ _sTitle: string; _nCount: number }>;
	_tsDateModified?: number;
	_tsDateAdded?: number;
	_iPinLevel?: number;
	_sText?: string;
	_nReplyCount?: number;
	children?: number[];
}

interface OnlineCommentState {
	total: number;
	count: number;
	data: Record<number, OnlineComment>;
	list: number[];
}

interface GameBananaListResponse<T> {
	_aMetadata?: {
		_nRecordCount?: number;
		_nPerpage?: number;
		_bIsComplete?: boolean;
	};
	_aRecords?: T[];
}

interface OnlineDetail extends Omit<OnlineMod, "_aComments" | "_aFiles" | "_aUpdates"> {
	_aCategory?: OnlineModCategory;
	_aGame?: { _idRow: number; _sName: string };
	_aPreviewMedia?: OnlineModPreviewMedia;
	_aFiles?: OnlineDownloadFile[];
	_aUpdates?: OnlineUpdate[];
	_aComments?: OnlineCommentState;
	_sText?: string;
	_eUpdate?: boolean;
	_bIsPrivate?: boolean;
	_bIsTrashed?: boolean;
	_bIsWithheld?: boolean;
}

interface ModPayloadSizeResult {
	bytes: number | null;
	error: string | null;
}

const RIGHT_ONLINE_TIME_REFERENCE_SECONDS = Date.now() / 1000;

function onlineFileKey(file: OnlineDownloadFile) {
	return String(file._idRow ?? file._sDownloadUrl);
}

function getSelectedDetail(data: OnlineData, selected: string): OnlineDetail | null {
	const value = data[selected];
	if (!value || Array.isArray(value) || typeof value !== "object") return null;
	return value as unknown as OnlineDetail;
}

function previewUrl(item: OnlineDetail | null): string {
	const image = item?._aPreviewMedia?._aImages?.[0];
	return image ? `${image._sBaseUrl}/${image._sFile}` : "";
}

function buildCommentState(
	current: OnlineCommentState | undefined,
	response: GameBananaListResponse<OnlineComment>
): OnlineCommentState {
	const previous = current || { total: 0, count: 0, data: {}, list: [] };
	const records = (response._aRecords || []).filter((comment) => comment._aPoster);
	const metadata = response._aMetadata || {};
	const total = metadata._nRecordCount || 0;
	const count = metadata._bIsComplete
		? total
		: Math.min(total, previous.count + (metadata._nPerpage || records.length));
	return {
		total,
		count,
		data: {
			...previous.data,
			...Object.fromEntries(records.map((comment) => [comment._idRow, comment])),
		},
		list: [...previous.list, ...records.map((comment) => comment._idRow).filter((id) => !previous.list.includes(id))],
	};
}

function CommentTree({
	commentIds,
	comments,
	depth = 0,
	now,
	viewRepliesLabel,
	onLoadReplies,
}: {
	commentIds: number[];
	comments: Record<number, OnlineComment>;
	depth?: number;
	now: number;
	viewRepliesLabel: string;
	onLoadReplies: (comment: OnlineComment) => void;
}) {
	return (
		<div className="flex w-full flex-col gap-3">
			{commentIds.map((commentId) => {
				const comment = comments[commentId];
				if (!comment) return null;
				return (
					<div key={commentId} className="border-l pl-3" style={{ marginLeft: Math.min(depth, 3) * 8 }}>
						<div className="flex items-center gap-2 py-2">
							<RemoteImage
								className="h-9 w-9 rounded-full object-cover"
								src={comment._aPoster?._sAvatarUrl || ""}
								fallbackSrc="/who.jpg"
							/>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium">{comment._aPoster?._sName || "Unknown"}</div>
								<div className="text-xs text-muted-foreground">
									{getTimeDifference(now, comment._tsDateModified || comment._tsDateAdded || 0)}
								</div>
							</div>
						</div>
						{comment._sText && <SafeHtml html={comment._sText} className="select-text text-sm" />}
						{comment._aStamps?.length ? (
							<div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
								{comment._aStamps.map((stamp) => (
									<span key={stamp._sTitle}>{`${stamp._sTitle} ${stamp._nCount}`}</span>
								))}
							</div>
						) : null}
						{comment.children?.length ? (
							<CommentTree
								commentIds={comment.children}
								comments={comments}
								depth={depth + 1}
								now={now}
								viewRepliesLabel={viewRepliesLabel}
								onLoadReplies={onLoadReplies}
							/>
						) : null}
						{comment._nReplyCount && !comment.children ? (
							<Button variant="ghost" size="sm" className="mt-2" onClick={() => onLoadReplies(comment)}>
								<MessageSquareIcon className="h-4 w-4" />
								{viewRepliesLabel}
							</Button>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function RightOnline({ open }: { open: boolean }) {
	const textData = useAtomValue(TEXT_DATA);
	const selected = useAtomValue(ONLINE_SELECTED);
	const setRightSlideOverOpen = useSetAtom(RIGHT_SLIDEOVER_OPEN);
	const [modList, setModList] = useAtom(MOD_LIST);
	const [data, setData] = useAtom(DATA);
	const [settings, setSettings] = useAtom(SETTINGS);
	const [onlineData, setOnlineData] = useAtom(ONLINE_DATA);
	const [fileToDownload, setFileToDownload] = useAtom(FILE_TO_DL);
	const setDownloadList = useSetAtom(DOWNLOAD_LIST);
	const installedItems = useAtomValue(INSTALLED_ITEMS);
	const game = useAtomValue(GAME);
	const provider = useMemo(() => (game ? getGameBananaProvider(game) : null), [game]);
	const item = getSelectedDetail(onlineData, selected);
	const [detailError, setDetailError] = useState("");
	const [detailRetry, setDetailRetry] = useState(0);
	const [commentsOpen, setCommentsOpen] = useState(false);
	const [loadingComments, setLoadingComments] = useState(false);
	const [aboutOpen, setAboutOpen] = useState(true);
	const [updatesOpen, setUpdatesOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkExistingOpen, setLinkExistingOpen] = useState(false);
	const [commandValue, setCommandValue] = useState("");
	const [linkPayloadSizes, setLinkPayloadSizes] = useState<Record<string, number | undefined>>({});
	const [linkPayloadErrors, setLinkPayloadErrors] = useState<Record<string, string>>({});
	const [linkSizesLoading, setLinkSizesLoading] = useState(false);
	const [selectedLinkPath, setSelectedLinkPath] = useState("");
	const [selectedLinkFile, setSelectedLinkFile] = useState("");
	const [independentVariant, setIndependentVariant] = useState(false);
	const [linkingMod, setLinkingMod] = useState(false);
	const [addonInstall, setAddonInstall] = useState(false);
	const [ignoreGameCheck, setIgnoreGameCheck] = useState(false);
	const detailGenerationRef = useRef(0);
	const commentsControllerRef = useRef<AbortController | null>(null);
	const linkSizeGenerationRef = useRef(0);
	const now = RIGHT_ONLINE_TIME_REFERENCE_SECONDS;

	useEffect(() => {
		if (!selected || !provider) return;
		const controller = new AbortController();
		const generation = ++detailGenerationRef.current;

		void (async () => {
			await Promise.resolve();
			if (controller.signal.aborted || generation !== detailGenerationRef.current) return;
			commentsControllerRef.current?.abort();
			linkSizeGenerationRef.current += 1;
			setDetailError("");
			setAboutOpen(true);
			setUpdatesOpen(false);
			setCommentsOpen(false);
			setFilesOpen(false);
			setLinkOpen(false);
			setLinkExistingOpen(false);
			setCommandValue("");
			setLinkPayloadSizes({});
			setLinkPayloadErrors({});
			setLinkSizesLoading(false);
			setSelectedLinkPath("");
			setSelectedLinkFile("");
			setIndependentVariant(false);
			setIgnoreGameCheck(false);
			setAddonInstall(false);
			setRightSlideOverOpen(true);
			setOnlineData((previous) => {
				const next = { ...previous };
				delete next[selected];
				return next;
			});

			const [detail, updates] = await Promise.all([
				provider.mod<OnlineDetail>(selected, controller.signal),
				provider.updates<GameBananaListResponse<OnlineUpdate>>(selected, controller.signal),
			]);
			if (controller.signal.aborted || generation !== detailGenerationRef.current) return;
			setOnlineData((previous) => ({
				...previous,
				[selected]: {
					...detail,
					_aUpdates: (updates._aRecords || []).map((update) => ({ ...update })),
					_eUpdate: Boolean(updates._aRecords?.length),
				},
			}));
		})().catch((error) => {
			if (controller.signal.aborted || isGameBananaAbortError(error)) return;
			setDetailError(error instanceof Error ? error.message : String(error || "详情加载失败"));
		});

		return () => {
			controller.abort();
			commentsControllerRef.current?.abort();
		};
	}, [detailRetry, provider, selected, setOnlineData, setRightSlideOverOpen]);

	const gameMatched = Boolean(item?._aGame && (ignoreGameCheck || GAME_GB_IDS[item._aGame._idRow] === game));
	const installedItem = installedItems.find((installed) => modRouteFromURL(installed.source) === selected) || null;
	const installLabel = installedItem ? (installedItem.modStatus ? "Update" : "Reinstall") : "Install";
	const sourceRoute = normalizeModRoute(selected || item?._sProfileUrl || "");
	const isBlacklisted = isRouteBlacklisted(settings.global.onlineBlacklist, game, sourceRoute);
	const categoryName =
		(item?._aCategory?._sName || item?._aRootCategory?._sName || UNCATEGORIZED).replaceAll("Skins", UNCATEGORIZED) ||
		UNCATEGORIZED;
	const itemPreviewUrl = previewUrl(item);
	const existingSources = useMemo(
		() => new Map(modList.map((mod) => [mod.name, data[mod.path]?.source || data[mod.name]?.source || ""])),
		[data, modList]
	);
	const rankedBindingCandidates = useMemo(
		() =>
			rankLocalBindingCandidates(
				modList,
				linkPayloadSizes,
				(item?._aFiles || []).map((file) => ({
					id: onlineFileKey(file),
					name: file._sFile,
					updatedAt: file._tsDateAdded,
					...(typeof file._nFilesize === "number" ? { size: file._nFilesize } : {}),
				}))
			),
		[item?._aFiles, linkPayloadSizes, modList]
	);
	const selectedBindingCandidate = useMemo(
		() => rankedBindingCandidates.find((candidate) => candidate.mod.path === selectedLinkPath) || null,
		[rankedBindingCandidates, selectedLinkPath]
	);
	const selectedOnlineFile = useMemo(
		() => (item?._aFiles || []).find((file) => onlineFileKey(file) === selectedLinkFile) || null,
		[item?._aFiles, selectedLinkFile]
	);
	const selectedModId = Number(item?._idRow || 0);
	const bindingConflicts = useMemo(
		() =>
			selectedLinkPath && Number.isSafeInteger(selectedModId) && selectedModId > 0
				? findGameBananaBindingConflicts(data, selectedLinkPath, selectedModId, new Set(modList.map((mod) => mod.path)))
				: [],
		[data, modList, selectedLinkPath, selectedModId]
	);

	function selectLocalModForBinding(candidate: { mod: Mod; closestFile?: GameBananaSelectedFile }) {
		setSelectedLinkPath(candidate.mod.path);
		setSelectedLinkFile(candidate.closestFile?.id || (item?._aFiles?.[0] ? onlineFileKey(item._aFiles[0]) : ""));
		setIndependentVariant(data[candidate.mod.path]?.gameBanana?.variant === "independent");
	}

	function handleLinkExistingOpenChange(nextOpen: boolean) {
		const generation = ++linkSizeGenerationRef.current;
		setLinkExistingOpen(nextOpen);
		setCommandValue("");
		setSelectedLinkPath("");
		setSelectedLinkFile("");
		setIndependentVariant(false);
		setLinkPayloadSizes({});
		setLinkPayloadErrors({});
		if (!nextOpen || !game || modList.length === 0) {
			setLinkSizesLoading(false);
			return;
		}

		setLinkSizesLoading(true);
		const remoteFiles = (item?._aFiles || []).map((file) => ({
			id: onlineFileKey(file),
			name: file._sFile,
			updatedAt: file._tsDateAdded,
			...(typeof file._nFilesize === "number" ? { size: file._nFilesize } : {}),
		}));
		void invoke<Record<string, ModPayloadSizeResult>>("measure_mod_payload_sizes", {
			game,
			relativePaths: modList.map((mod) => mod.path),
		})
			.then((results) => {
				if (generation !== linkSizeGenerationRef.current) return;
				const sizes: Record<string, number> = {};
				const errors: Record<string, string> = {};
				Object.entries(results).forEach(([path, result]) => {
					if (Number.isSafeInteger(result.bytes) && Number(result.bytes) >= 0) sizes[path] = Number(result.bytes);
					if (result.error) errors[path] = result.error;
				});
				setLinkPayloadSizes(sizes);
				setLinkPayloadErrors(errors);
				const candidate = rankLocalBindingCandidates(modList, sizes, remoteFiles)[0];
				if (candidate) selectLocalModForBinding(candidate);
			})
			.catch((error) => {
				if (generation !== linkSizeGenerationRef.current) return;
				const fallbackCandidate = rankLocalBindingCandidates(modList, {}, remoteFiles)[0];
				if (fallbackCandidate) selectLocalModForBinding(fallbackCandidate);
				addToast({ type: "error", message: `无法比较 Mod 大小：${String(error)}` });
			})
			.finally(() => {
				if (generation === linkSizeGenerationRef.current) setLinkSizesLoading(false);
			});
	}

	const syncBlacklistToMods = useCallback(
		(route: string, blacklisted: boolean) => {
			setData((previous) => {
				const next = { ...previous };
				Object.entries(previous).forEach(([path, modData]) => {
					if (normalizeModRoute(modData.source) !== route) return;
					next[path] = { ...modData, tags: withBlacklistTag(modData.tags, blacklisted) };
				});
				return next;
			});
			setModList((previous) =>
				previous.map((mod) =>
					normalizeModRoute(mod.source) === route ? { ...mod, tags: withBlacklistTag(mod.tags, blacklisted) } : mod
				)
			);
		},
		[setData, setModList]
	);

	const toggleBlacklist = useCallback(() => {
		if (!sourceRoute) return;
		const nextBlacklisted = !isBlacklisted;
		setSettings((previous) => {
			const retained = (previous.global.onlineBlacklist || []).filter(
				(entry) => !(entry.game === game && normalizeModRoute(entry.route || entry.source) === sourceRoute)
			);
			return {
				...previous,
				global: {
					...previous.global,
					onlineBlacklist: nextBlacklisted
						? [
								...retained,
								{
									game,
									route: sourceRoute,
									source: item?._sProfileUrl || "",
									name: item?._sName || "",
									createdAt: Date.now(),
								},
							]
						: retained,
				},
			};
		});
		syncBlacklistToMods(sourceRoute, nextBlacklisted);
		void saveConfigs();
		addToast({
			type: nextBlacklisted ? "error" : "success",
			message: nextBlacklisted ? "已加入黑名单" : "已移出黑名单",
		});
	}, [game, isBlacklisted, item?._sName, item?._sProfileUrl, setSettings, sourceRoute, syncBlacklistToMods]);

	function addToDownloadQueue(file: OnlineDownloadFile, addon = addonInstall) {
		if (!item) return;
		const modId = Number(item._idRow);
		const fileId = String(file._idRow ?? "").trim();
		const expectedSize = Number(file._nFilesize);
		const expectedMd5 = String(file._sMd5Checksum || "")
			.trim()
			.toLowerCase();
		if (
			!Number.isSafeInteger(modId) ||
			modId <= 0 ||
			!/^[A-Za-z0-9_-]+$/.test(fileId) ||
			!Number.isSafeInteger(expectedSize) ||
			expectedSize <= 0 ||
			!/^[a-f0-9]{32}$/.test(expectedMd5)
		) {
			addToast({ type: "error", message: "GameBanana 文件缺少可验证的大小、MD5 或文件身份，无法安全下载" });
			return;
		}
		setDownloadList((previous) => {
			const allDownloads = [
				...(previous.downloading || []),
				...(previous.extracting || []),
				...(previous.queue || []),
				...(previous.completed || []),
				...(previous.failed || []),
			];
			const baseName = item._sName + (addon ? ` - ${file._sFile}` : "");
			let name = baseName;
			let suffix = 1;
			while (
				allDownloads.some((download) => download.name === name && download.fname === file._sFile) ||
				(existingSources.has(name) && existingSources.get(name) !== item._sProfileUrl)
			) {
				name = `${baseName} (${suffix++})`;
			}
			const download: DownloadItem = {
				status: "pending",
				addon,
				preview: itemPreviewUrl,
				category: categoryName,
				source: item._sProfileUrl,
				file: file._sDownloadUrl,
				updated: file._tsDateAdded,
				name,
				displayName: item._sName,
				fname: file._sFile,
				requeueRounds: 0,
				createdAt: Date.now(),
				expectedSize,
				gameBananaModId: modId,
				gameBananaFileId: fileId,
				expectedHash: { algorithm: "md5", value: expectedMd5 },
			};
			const next: DownloadList = { ...previous, queue: [...(previous.queue || []), download] };
			return next;
		});
		addToast({ type: "success", message: textData._Toasts.FileAdded });
		setFilesOpen(false);
	}

	const consumeRequestedDownload = useEffectEvent((requestedFileId: string, requestedRoute: string) => {
		if (selected !== requestedRoute || !gameMatched) return;
		const file = item?._aFiles?.find((candidate) => String(candidate._idRow) === requestedFileId);
		if (file) addToDownloadQueue(file, false);
		setFileToDownload("");
	});

	useEffect(() => {
		if (!item?._aFiles?.length || !fileToDownload || !gameMatched) return;
		let active = true;
		const requestedFileId = String(fileToDownload);
		const requestedRoute = selected;
		queueMicrotask(() => {
			if (active) consumeRequestedDownload(requestedFileId, requestedRoute);
		});
		return () => {
			active = false;
		};
	}, [fileToDownload, gameMatched, item?._aFiles, selected]);

	async function loadComments() {
		if (!provider || !selected || !item || loadingComments) return;
		commentsControllerRef.current?.abort();
		const controller = new AbortController();
		commentsControllerRef.current = controller;
		setLoadingComments(true);
		try {
			const page = Math.floor((item._aComments?.count || 0) / 15) + 1;
			const response = await provider.comments<GameBananaListResponse<OnlineComment>>(
				selected,
				page,
				controller.signal
			);
			if (controller.signal.aborted) return;
			setOnlineData((previous) => {
				const current = getSelectedDetail(previous, selected);
				if (!current) return previous;
				return {
					...previous,
					[selected]: {
						...current,
						_aComments: buildCommentState(current._aComments, response),
					},
				};
			});
		} catch (error) {
			if (!controller.signal.aborted && !isGameBananaAbortError(error)) {
				addToast({ type: "error", message: "评论加载失败" });
			}
		} finally {
			if (commentsControllerRef.current === controller) {
				commentsControllerRef.current = null;
				setLoadingComments(false);
			}
		}
	}

	function handleCommentsOpenChange(nextOpen: boolean) {
		setCommentsOpen(nextOpen);
		if (nextOpen && item && !item._aComments && !loadingComments) void loadComments();
	}

	async function loadReplies(comment: OnlineComment) {
		if (!provider || !selected) return;
		try {
			const response = await provider.nestedComments<GameBananaListResponse<OnlineComment>>(String(comment._idRow));
			const children = (response._aRecords || []).filter((child) => child._aPoster);
			setOnlineData((previous) => {
				const current = getSelectedDetail(previous, selected);
				if (!current?._aComments) return previous;
				return {
					...previous,
					[selected]: {
						...current,
						_aComments: {
							...current._aComments,
							data: {
								...current._aComments.data,
								[comment._idRow]: { ...comment, children: children.map((child) => child._idRow) },
								...Object.fromEntries(children.map((child) => [child._idRow, child])),
							},
						},
					},
				};
			});
		} catch (error) {
			if (!isGameBananaAbortError(error)) addToast({ type: "error", message: "回复加载失败" });
		}
	}

	const itemId = item?._idRow;
	const installedItemName = installedItem?.name;

	useEffect(() => {
		if (!itemId || !installedItemName) return;
		setData((previous: ModDataObj) => ({
			...previous,
			[installedItemName]: { ...previous[installedItemName], viewedAt: Date.now() },
		}));
		void refreshModList().then(setModList);
		void saveConfigs();
	}, [installedItemName, itemId, setData, setModList]);

	async function linkToLocalMod() {
		if (!item || !selectedLinkPath || !Number.isSafeInteger(selectedModId) || selectedModId <= 0) return;
		if (!itemPreviewUrl) {
			addToast({ type: "error", message: "该 GameBanana Mod 没有可用预览图，无法完成绑定" });
			return;
		}
		if (bindingConflicts.length > 0 && !independentVariant) {
			addToast({ type: "error", message: `该 GameBanana ID 已绑定到 ${bindingConflicts.join("、")}` });
			return;
		}
		const selectedFile = selectedOnlineFile
			? ({
					id: onlineFileKey(selectedOnlineFile),
					name: selectedOnlineFile._sFile,
					size: Number(selectedOnlineFile._nFilesize || 0),
					updatedAt: Number(selectedOnlineFile._tsDateAdded || 0),
				} satisfies GameBananaSelectedFile)
			: undefined;
		const binding = createGameBananaBinding({
			modId: selectedModId,
			profileUrl: item._sProfileUrl,
			independentVariant,
			...(selectedFile ? { selectedFile } : {}),
		});
		const previousRecord = data[selectedLinkPath];
		const nextRecord = {
			...previousRecord,
			source: item._sProfileUrl,
			gameBanana: binding,
			updatedAt: Date.now(),
			viewedAt: 0,
			tags: withBlacklistTag(previousRecord?.tags, isBlacklisted),
		};
		const nextData: ModDataObj = { ...data, [selectedLinkPath]: nextRecord };
		setLinkingMod(true);
		try {
			setData(nextData);
			setModList((previous) =>
				previous.map((mod) =>
					mod.path === selectedLinkPath
						? {
								...mod,
								source: item._sProfileUrl,
								gameBanana: binding,
								tags: withBlacklistTag(mod.tags, isBlacklisted),
							}
						: mod
				)
			);
			await saveGameBananaBinding(game, selectedLinkPath, itemPreviewUrl, nextData);
			void refreshModList()
				.then(setModList)
				.catch((error) => addToast({ type: "error", message: `绑定已保存，但列表刷新失败：${String(error)}` }));
			setLinkExistingOpen(false);
			setLinkOpen(false);
			setSelectedLinkPath("");
			setSelectedLinkFile("");
			addToast({ type: "success", message: textData._RightSideBar._RightOnline.LinkToModSuccess });
		} catch (error) {
			setData((previous) => {
				if (previous[selectedLinkPath]?.gameBanana?.boundAt !== binding.boundAt) return previous;
				const next = { ...previous };
				if (previousRecord) next[selectedLinkPath] = previousRecord;
				else delete next[selectedLinkPath];
				return next;
			});
			setModList((previous) =>
				previous.map((mod) => {
					if (mod.path !== selectedLinkPath) return mod;
					const restored: Mod = { ...mod };
					if (previousRecord?.source !== undefined) restored.source = previousRecord.source;
					else delete restored.source;
					if (previousRecord?.gameBanana !== undefined) restored.gameBanana = previousRecord.gameBanana;
					else delete restored.gameBanana;
					return restored;
				})
			);
			addToast({ type: "error", message: `绑定保存失败：${String(error)}` });
		} finally {
			setLinkingMod(false);
		}
	}

	const privateState = item?._bIsPrivate
		? "Private"
		: item?._bIsTrashed
			? "Deleted"
			: item?._bIsWithheld
				? "Withheld"
				: "";

	return (
		<AnimatePresence mode="wait">
			{open && (
				<motion.aside
					initial={{ translateX: "100%", opacity: 0 }}
					animate={{ translateX: "0%", opacity: 1 }}
					exit={{ translateX: "100%", opacity: 0 }}
					transition={{ duration: 0.25 }}
					className="bg-sidebar bgpattern fixed right-0 z-10 flex h-full w-[min(50rem,50vw)] flex-col overflow-hidden border-l pt-8"
				>
					{!selected ? (
						<div className="flex h-full items-center justify-center p-4 text-accent">
							{textData._RightSideBar._RightOnline.NoItem}
						</div>
					) : detailError ? (
						<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
							<TriangleAlertIcon className="h-7 w-7 text-destructive" />
							<span>{detailError}</span>
							<Button variant="outline" onClick={() => setDetailRetry((value) => value + 1)}>
								<RefreshCwIcon className="h-4 w-4" />
								重试
							</Button>
						</div>
					) : !item ? (
						<div className="flex h-full items-center justify-center">
							<LoaderIcon className="h-8 w-8 animate-spin text-accent" />
						</div>
					) : privateState ? (
						<div className="flex h-full flex-col items-center justify-center gap-4 p-4 text-accent">
							{textData._RightSideBar._RightOnline[privateState as "Private" | "Deleted" | "Withheld"]}
							<Button variant="outline" onClick={() => void openUrl(item._sProfileUrl)}>
								<ExternalLinkIcon className="h-4 w-4" />
								{textData._RightSideBar._RightOnline.OpenBrowser}
							</Button>
						</div>
					) : (
						<>
							<header className="flex min-h-16 items-center gap-3 border-b px-3 text-accent">
								<RemoteImage
									className="h-9 w-9 rounded object-cover"
									src={item._aCategory?._sIconUrl || item._aRootCategory?._sIconUrl || ""}
									fallbackSrc="/who.jpg"
								/>
								<Label className="min-w-0 flex-1 truncate text-center text-xl">{item._sName}</Label>
								<RemoteImage
									className="h-9 w-9 rounded-full object-cover"
									src={item._aSubmitter?._sAvatarUrl || ""}
									fallbackSrc="/who.jpg"
								/>
							</header>

							<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" id="container">
								{isBlacklisted && (
									<div className="flex items-center gap-2 border-y border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
										<TriangleAlertIcon className="h-4 w-4" />
										已加入黑名单
									</div>
								)}
								{item._aPreviewMedia?._aImages?.length ? <Carousel data={item._aPreviewMedia._aImages} big /> : null}
								<div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y py-3 text-sm sm:grid-cols-4">
									<span className="flex items-center gap-1">
										<ThumbsUpIcon className="h-4 w-4" /> {item._nLikeCount || 0}
									</span>
									<span className="flex items-center gap-1">
										<DownloadIcon className="h-4 w-4" /> {item._nDownloadCount || 0}
									</span>
									<span>{item._aCategory?._sName || item._aRootCategory?._sName || UNCATEGORIZED}</span>
									<span className="truncate text-right">{item._aSubmitter?._sName}</span>
								</div>

								{!gameMatched && item._aGame ? (
									<div className="flex items-center justify-between gap-3 border-y border-warn/40 bg-warn/10 px-3 py-2 text-sm">
										<span>{item._aGame._sName}</span>
										<Button size="sm" variant="outline" onClick={() => setIgnoreGameCheck(true)}>
											继续
										</Button>
									</div>
								) : null}

								{item._sText && (
									<Collapsible open={aboutOpen} onOpenChange={setAboutOpen}>
										<CollapsibleTrigger asChild>
											<Button className="w-full justify-between" variant="outline">
												{textData._RightSideBar._RightOnline.About}
												<ChevronDownIcon className={`h-4 w-4 transition-transform ${aboutOpen ? "rotate-180" : ""}`} />
											</Button>
										</CollapsibleTrigger>
										<CollapsibleContent className="select-text px-2 py-3">
											<SafeHtml html={item._sText} className="font-sans" />
										</CollapsibleContent>
									</Collapsible>
								)}

								{item._aUpdates?.length ? (
									<Collapsible open={updatesOpen} onOpenChange={setUpdatesOpen}>
										<CollapsibleTrigger asChild>
											<Button className="w-full justify-between" variant="outline">
												{textData._RightSideBar._RightOnline.Updates}
												<ChevronDownIcon
													className={`h-4 w-4 transition-transform ${updatesOpen ? "rotate-180" : ""}`}
												/>
											</Button>
										</CollapsibleTrigger>
										<CollapsibleContent className="flex flex-col gap-3 px-2 py-3">
											{item._aUpdates.map((update, index) => (
												<div key={`${update._sVersion || "update"}-${index}`} className="border-b pb-3">
													<div className="flex justify-between gap-3 text-sm font-medium">
														<span>{update._sName || update._sVersion || "Update"}</span>
														<span className="text-xs text-muted-foreground">
															{getTimeDifference(now, update._tsDateModified || update._tsDateAdded || 0)}
														</span>
													</div>
													{update._sText && <SafeHtml html={update._sText} className="mt-2 text-sm" />}
												</div>
											))}
										</CollapsibleContent>
									</Collapsible>
								) : null}

								<Collapsible open={commentsOpen} onOpenChange={handleCommentsOpenChange}>
									<CollapsibleTrigger asChild>
										<Button className="w-full justify-between" variant="outline">
											{textData._RightSideBar._RightOnline.Comments}
											<ChevronDownIcon className={`h-4 w-4 transition-transform ${commentsOpen ? "rotate-180" : ""}`} />
										</Button>
									</CollapsibleTrigger>
									<CollapsibleContent className="px-2 py-3">
										{item._aComments?.list.length ? (
											<CommentTree
												commentIds={item._aComments.list}
												comments={item._aComments.data}
												now={now}
												viewRepliesLabel={textData._RightSideBar._RightOnline.ViewReps}
												onLoadReplies={(comment) => void loadReplies(comment)}
											/>
										) : null}
										{loadingComments ? (
											<div className="flex justify-center p-4">
												<LoaderIcon className="animate-spin" />
											</div>
										) : item._aComments && item._aComments.count < item._aComments.total ? (
											<Button className="mt-3 w-full" variant="ghost" onClick={() => void loadComments()}>
												{textData._RightSideBar._RightOnline.LoadMore}
											</Button>
										) : item._aComments && item._aComments.total === 0 ? (
											<div className="p-4 text-center text-sm text-muted-foreground">
												{textData._RightSideBar._RightOnline.NoComs}
											</div>
										) : null}
									</CollapsibleContent>
								</Collapsible>
							</div>

							<footer className="flex min-h-16 flex-wrap items-center justify-center gap-2 border-t bg-background/50 p-2 backdrop-blur-md">
								<Popover open={filesOpen} onOpenChange={setFilesOpen}>
									<PopoverTrigger asChild>
										<Button disabled={!gameMatched || !item._aFiles?.length}>
											<DownloadIcon className="h-4 w-4" />
											{installLabel}
										</Button>
									</PopoverTrigger>
									<PopoverContent className="w-96 bg-sidebar p-2">
										<div className="mb-2 flex items-center justify-between border-b px-2 pb-2">
											<Label htmlFor="addon-install">作为附加包</Label>
											<Switch id="addon-install" checked={addonInstall} onCheckedChange={setAddonInstall} />
										</div>
										<div className="max-h-96 overflow-y-auto">
											{item._aFiles?.map((file) => (
												<Button
													key={`${file._idRow || file._sDownloadUrl}`}
													variant="ghost"
													className="h-auto w-full justify-between gap-3 border-b py-3 text-left"
													onClick={() => addToDownloadQueue(file)}
												>
													<span className="min-w-0 flex-1 whitespace-normal break-words">
														{file._sFile}
														{file._sDescription ? (
															<small className="mt-1 block text-muted-foreground">{file._sDescription}</small>
														) : null}
													</span>
													<span className="flex min-w-24 flex-col items-end text-xs text-muted-foreground">
														<span className="flex items-center gap-1">
															<DiscIcon className="h-3 w-3" /> {formatSize(file._nFilesize || 0)}
														</span>
														<span>{getTimeDifference(now, file._tsDateAdded)}</span>
													</span>
												</Button>
											))}
										</div>
									</PopoverContent>
								</Popover>

								<Popover open={linkOpen} onOpenChange={setLinkOpen}>
									<PopoverTrigger asChild>
										<Button variant="outline">
											<LinkIcon className="h-4 w-4" />
											链接
										</Button>
									</PopoverTrigger>
									<PopoverContent className="w-72 bg-sidebar p-2">
										<Button
											className="w-full"
											variant="ghost"
											onClick={() => void navigator.clipboard.writeText(item._sProfileUrl)}
										>
											<CopyIcon className="h-4 w-4" />
											{textData._RightSideBar._RightOnline.CopyLink}
										</Button>
										<Button className="w-full" variant="ghost" onClick={() => void openUrl(item._sProfileUrl)}>
											<ExternalLinkIcon className="h-4 w-4" />
											{textData._RightSideBar._RightOnline.OpenBrowser}
										</Button>
										{gameMatched && (
											<Popover open={linkExistingOpen} onOpenChange={handleLinkExistingOpenChange}>
												<PopoverTrigger asChild>
													<Button className="w-full" variant="ghost">
														{textData._RightSideBar._RightOnline.LinkToMod}
													</Button>
												</PopoverTrigger>
												<PopoverContent className="w-96 bg-sidebar p-2">
													<Command>
														<CommandInput
															value={commandValue}
															onValueChange={setCommandValue}
															placeholder={textData.Search}
														/>
														<CommandList className="max-h-64">
															<CommandEmpty>{textData._RightSideBar._RightLocal.NoCat}</CommandEmpty>
															<CommandGroup>
																{rankedBindingCandidates.map((candidate, index) => (
																	<CommandItem
																		key={candidate.mod.path}
																		value={`${candidate.mod.path} ${candidate.mod.name}`}
																		onSelect={() => selectLocalModForBinding(candidate)}
																		className="items-start gap-2"
																	>
																		<RemoteImage
																			className="h-10 w-10 rounded object-cover"
																			src={getImageUrl(candidate.mod.path)}
																			fallbackSrc="/who.jpg"
																		/>
																		<span className="min-w-0 flex-1">
																			<span className="flex items-center gap-1 truncate">
																				{candidate.mod.name}
																				{selectedLinkPath === candidate.mod.path ? (
																					<CheckIcon className="h-3 w-3" />
																				) : null}
																			</span>
																			<small className="block whitespace-normal text-muted-foreground">
																				{candidate.localSize === undefined
																					? linkPayloadErrors[candidate.mod.path] ||
																						(linkSizesLoading ? "正在统计大小" : "大小不可用")
																					: `${formatSize(candidate.localSize)} · ${candidate.closestFile?.name || "无文件大小"}${
																							candidate.difference === undefined
																								? ""
																								: ` · 差 ${formatSize(candidate.difference)}`
																						}`}
																			</small>
																		</span>
																		{index === 0 && candidate.difference !== undefined ? (
																			<span className="shrink-0 text-xs text-primary">最接近</span>
																		) : null}
																	</CommandItem>
																))}
															</CommandGroup>
														</CommandList>
													</Command>
													{selectedBindingCandidate ? (
														<div className="mt-2 space-y-2 border-t pt-2">
															<Label htmlFor="binding-file">用于后续更新的文件</Label>
															<select
																id="binding-file"
																className="h-9 w-full rounded border bg-background px-2 text-sm"
																value={selectedLinkFile}
																onChange={(event) => setSelectedLinkFile(event.target.value)}
															>
																{(item?._aFiles || []).map((file) => (
																	<option key={onlineFileKey(file)} value={onlineFileKey(file)}>
																		{file._sFile} · {formatSize(file._nFilesize || 0)} ·{" "}
																		{getTimeDifference(now, file._tsDateAdded)}
																	</option>
																))}
															</select>
															{bindingConflicts.length > 0 ? (
																<div className="space-y-2 rounded border border-destructive/50 p-2 text-xs">
																	<p>此 GameBanana ID 已绑定：{bindingConflicts.join("、")}</p>
																	<div className="flex items-center justify-between gap-3">
																		<Label htmlFor="independent-variant">作为独立变体</Label>
																		<Switch
																			id="independent-variant"
																			checked={independentVariant}
																			onCheckedChange={setIndependentVariant}
																		/>
																	</div>
																</div>
															) : null}
															<Button
																className="w-full"
																disabled={
																	linkingMod ||
																	!selectedLinkFile ||
																	(bindingConflicts.length > 0 && !independentVariant)
																}
																onClick={() => void linkToLocalMod()}
															>
																{linkingMod ? (
																	<LoaderIcon className="h-4 w-4 animate-spin" />
																) : (
																	<LinkIcon className="h-4 w-4" />
																)}
																确认绑定
															</Button>
														</div>
													) : null}
												</PopoverContent>
											</Popover>
										)}
									</PopoverContent>
								</Popover>

								<Button variant="outline" onClick={toggleBlacklist}>
									{isBlacklisted ? <RefreshCwIcon className="h-4 w-4" /> : <BanIcon className="h-4 w-4" />}
									{isBlacklisted ? "移出黑名单" : "黑名单"}
								</Button>
							</footer>
						</>
					)}
				</motion.aside>
			)}
		</AnimatePresence>
	);
}

export default RightOnline;
