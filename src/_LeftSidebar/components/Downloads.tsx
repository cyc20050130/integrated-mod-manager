import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Check, Clock, DownloadIcon, FileQuestionIcon, FolderArchiveIcon, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CATEGORIES, DATA, DOWNLOAD_LIST, GAME, LEFT_SIDEBAR_OPEN, MOD_LIST, SETTINGS, TEXT_DATA } from "@/utils/vars";
import { deriveNameFromFileName, formatBytes, sanitizeFileName } from "@/utils/utils";
import {
	cleanCancelledDownload,
	createModDownloadDir,
	refreshModList,
	saveConfigs,
	validateModDownload,
} from "@/utils/filesys";
import { DownloadItem } from "@/utils/types";
import { UNCATEGORIZED } from "@/utils/consts";
import { info } from "@/lib/logger";
import { normalizeDownloadSettings } from "@/utils/downloads";

type DownloadRow = DownloadItem & {
	status: "pending" | "downloading" | "completed" | "failed" | "extracting";
};

type ProgressSnapshot = {
	percent: number;
	text: string;
};

const EMPTY_PROGRESS: ProgressSnapshot = {
	percent: 0,
	text: " - ",
};
const PROGRESS_REFRESH_INTERVAL_MS = 120;
const REQUEUE_COOLDOWN_MS = 4000;

const Icons = {
	pending: <Clock className="min-h-4 min-w-4 max-w-4" />,
	downloading: <Loader2 className="min-h-4 min-w-4 max-w-4 animate-spin" />,
	completed: <Check className="min-h-4 min-w-4 max-w-4" />,
	failed: <X className="min-h-4 min-w-4 max-w-4 text-destructive" />,
	extracting: <FolderArchiveIcon className="min-h-4 min-w-4 max-w-4 animate-pulse" />,
} as const;

let extracts: Record<string, DownloadItem> = {};
export function addToExtracts(key: string, element: DownloadItem) {
	extracts[key] = element;
}

function sameDownload(a: DownloadItem, b: DownloadItem) {
	if (a.key && b.key) return a.key === b.key;
	return a.name === b.name && a.file === b.file && a.fname === b.fname && a.updated === b.updated;
}

function getDownloadKey(item: DownloadItem) {
	return item.key || `${item.name}_${item.file}_${item.fname}_${item.updated}`;
}
function createRuntimeKey(item: DownloadItem, safeName: string) {
	const safeFile = toSafeName(deriveNameFromFileName(item.fname) || "file");
	return `${safeName}_${safeFile}_${item.updated}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}
function toSafeName(name: string) {
	return sanitizeFileName(name, { replacement: "_", defaultName: "untitled", maxLength: 120 });
}

function isPermanentPathError(message: string) {
	const text = String(message || "").toLowerCase();
	return (
		text.includes("the system cannot find the path specified") ||
		text.includes("cannot find the path specified") ||
		text.includes("error 3") ||
		text.includes("path not found") ||
		text.includes("no such file or directory") ||
		text.includes("os error 3")
	);
}

function inferFailureStageFromMessage(message: string) {
	const text = String(message || "").toLowerCase();
	if (text.includes("extraction failed") || text.includes("7z") || text.includes("stage: extract")) {
		return "extract";
	}
	if (isPermanentPathError(message)) {
		return "filesystem";
	}
	return "download";
}

function Downloads() {
	const textData = useAtomValue(TEXT_DATA);
	const [downloads, setDownloads] = useAtom(DOWNLOAD_LIST);
	const categories = useAtomValue(CATEGORIES);
	const [data, setData] = useAtom(DATA);
	const settings = useAtomValue(SETTINGS);
	const [dialogOpen, setDialogOpen] = useState(false);
	const leftSidebarOpen = useAtomValue(LEFT_SIDEBAR_OPEN);
	const modList = useSetAtom(MOD_LIST);
	const game = useAtomValue(GAME);
	const downloadRef = useRef<HTMLDivElement>(null);
	const downloadRef2 = useRef<HTMLDivElement>(null);
	const downloadRef3 = useRef<HTMLDivElement>(null);
	const persistTimerRef = useRef<number | null>(null);
	const retryWakeTimerRef = useRef<number | null>(null);
	const progressFrameRef = useRef<number | null>(null);
	const lastProgressFlushRef = useRef(0);
	const downloadsRef = useRef(downloads);
	const startedKeysRef = useRef<Set<string>>(new Set());
	const cancelRequestedRef = useRef<Set<string>>(new Set());
	const progressRef = useRef<Record<string, ProgressSnapshot>>({});
	const [progressTick, setProgressTick] = useState(0);
	const [queueWakeTick, setQueueWakeTick] = useState(0);

	const dlSettings = useMemo(() => normalizeDownloadSettings(settings.game.download), [settings.game.download]);

	const scheduleSave = useCallback(() => {
		if (persistTimerRef.current) {
			window.clearTimeout(persistTimerRef.current);
		}
		persistTimerRef.current = window.setTimeout(() => {
			void saveConfigs();
		}, 300);
	}, []);

	const scheduleProgressRefresh = useCallback(
		(forceImmediate = false) => {
			const now = performance.now();
			if (forceImmediate && now - lastProgressFlushRef.current >= PROGRESS_REFRESH_INTERVAL_MS) {
				lastProgressFlushRef.current = now;
				setProgressTick((tick) => tick + 1);
				return;
			}
			if (progressFrameRef.current !== null) return;
			progressFrameRef.current = window.requestAnimationFrame(() => {
				progressFrameRef.current = null;
				const current = performance.now();
				if (current - lastProgressFlushRef.current < PROGRESS_REFRESH_INTERVAL_MS) return;
				lastProgressFlushRef.current = current;
				setProgressTick((tick) => tick + 1);
			});
		},
		[]
	);

	const enrichForDownload = useCallback(
		(item: DownloadItem): DownloadItem => {
			let category = item.category;
			if (category === "Other/Misc") category = "Other";
			else if (!categories.find((cat) => cat._sName === category)) category = UNCATEGORIZED;

			let displayName = (item.displayName || item.name || "").trim();
			if (!item.addon) {
				let count = 0;
				let existingName = "";
				let existingCategory = category;
				for (const key in data) {
					if (data[key].source === item.source) {
						count++;
						const [linkedCategory = category, ...rest] = key.split("\\");
						if (rest.length > 0) {
							existingCategory = linkedCategory || category;
							existingName = rest.join("\\");
						}
					}
				}
				if (count === 1 && existingName) {
					displayName = existingName;
					category = existingCategory;
				}
			}
			if (!displayName) {
				displayName = deriveNameFromFileName(item.fname) || item.name || "untitled";
			}
			let safeName = toSafeName(item.safeName || displayName);
			if (!safeName) {
				safeName = toSafeName(item.name || displayName || deriveNameFromFileName(item.fname));
			}
			const key = createRuntimeKey(item, safeName);

			return {
				...item,
				name: safeName,
				displayName,
				safeName,
				category,
				status: "downloading",
				key,
				requeueRounds: item.requeueRounds || 0,
				createdAt: item.createdAt || Date.now(),
				lastTriedAt: Date.now(),
			};
		},
		[categories, data]
	);

		const handleDownloadFailure = useCallback(
			(itemKey: string, errorMessage: string, stage = "download") => {
				delete extracts[itemKey];
				delete progressRef.current[itemKey];
				setDownloads((prev) => {
				const activeFromDownloading = prev.downloading.find((x) => x.key === itemKey);
				const activeFromExtracting = prev.extracting.find((x) => x.key === itemKey);
				const active = activeFromDownloading || activeFromExtracting;

				if (!active) return prev;

				const next = {
					...active,
					lastError: errorMessage,
					lastTriedAt: Date.now(),
				};

				const fromDownloading = prev.downloading.filter((x) => x.key !== itemKey);
				const fromExtracting = prev.extracting.filter((x) => x.key !== itemKey);
				const cancelled = cancelRequestedRef.current.has(itemKey);
				cancelRequestedRef.current.delete(itemKey);

				if (cancelled) {
					return {
						...prev,
						downloading: fromDownloading,
						extracting: fromExtracting,
					};
				}

				const normalizedStage = String(stage || "download").toLowerCase();
				const shouldRequeue =
					normalizedStage === "download" && !isPermanentPathError(errorMessage);
				const rounds = (next.requeueRounds || 0) + 1;
				if (shouldRequeue && rounds <= dlSettings.maxRequeueRounds) {
					const retryAt = Date.now() + REQUEUE_COOLDOWN_MS;
					const {
						key: _oldKey,
						path: _oldPath,
						dlPath: _oldDlPath,
						safeName: _oldSafeName,
						...retryBase
					} = next;
					const retryItem: DownloadItem = {
						...retryBase,
						status: "pending",
						requeueRounds: rounds,
						lastTriedAt: retryAt,
					};
					return {
						...prev,
						downloading: fromDownloading,
						extracting: fromExtracting,
						queue: [...prev.queue, retryItem],
					};
				}

				return {
					...prev,
					downloading: fromDownloading,
					extracting: fromExtracting,
					failed: [...prev.failed, { ...next, status: "failed", requeueRounds: rounds }],
				};
			});
		},
		[dlSettings.maxRequeueRounds, setDownloads]
	);

	const startDownload = useCallback(
		async (item: DownloadItem) => {
			const runtimeName = toSafeName(item.safeName || item.name || item.displayName || deriveNameFromFileName(item.fname));
			const key = item.key || createRuntimeKey(item, runtimeName);
			let createdDlPath: string | null = null;
			try {
				const dlPath = await createModDownloadDir(item.category, runtimeName);
				if (!dlPath) throw new Error("Failed to create download directory");
				createdDlPath = dlPath;
				const runtimeItem: DownloadItem = {
					...item,
					key,
					name: runtimeName,
					safeName: runtimeName,
					path: `${item.category}\\${runtimeName}`,
					dlPath,
					updatedAt: item.updated * 1000,
				};

				setDownloads((prev) => ({
					...prev,
					downloading: prev.downloading.map((x) => (x.key === key ? { ...x, ...runtimeItem } : x)),
				}));

				setData((prevData) => {
					if (runtimeItem.path) {
						prevData[runtimeItem.path] = {
							source: runtimeItem.source,
							updatedAt: prevData[runtimeItem.path]?.updatedAt || -1,
							...prevData[runtimeItem.path],
						};
					}
					return { ...prevData };
				});
				scheduleSave();

				const downloadOptions = {
					connectTimeoutSec: dlSettings.connectTimeoutSec,
					stallTimeoutSec: dlSettings.stallTimeoutSec,
					requestRetries: dlSettings.requestRetries,
					progressIntervalMs: dlSettings.progressIntervalMs,
					progressBytesThreshold: dlSettings.progressBytesThresholdKB * 1024,
					backoffBaseMs: dlSettings.backoffBaseMs,
					maxConcurrentExtracts: dlSettings.maxConcurrentExtracts,
				};

				await invoke("download_and_unzip", {
					fileName: runtimeName,
					downloadUrl: item.file,
					savePath: dlPath,
					key,
					emit: true,
					downloadOptions,
				});

				if (item.preview) {
					void invoke("download_and_unzip", {
						fileName: "preview",
						downloadUrl: item.preview,
						savePath: dlPath,
						key: "link_preview_" + key,
						emit: false,
						downloadOptions: {
							...downloadOptions,
							requestRetries: 1,
						},
					}).catch(() => {});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (createdDlPath) void cleanCancelledDownload(createdDlPath);
				handleDownloadFailure(key, message, inferFailureStageFromMessage(message));
			} finally {
				startedKeysRef.current.delete(key);
			}
		},
		[dlSettings, handleDownloadFailure, scheduleSave, setData, setDownloads]
	);

	useEffect(() => {
		downloadsRef.current = downloads;
		scheduleSave();
	}, [downloads, scheduleSave]);

	useEffect(() => {
		if (retryWakeTimerRef.current) {
			window.clearTimeout(retryWakeTimerRef.current);
			retryWakeTimerRef.current = null;
		}
		if (!downloads.queue.length) return;
		const availableSlots = dlSettings.maxConcurrentDownloads - downloads.downloading.length;
		if (availableSlots <= 0) return;

		const now = Date.now();
		const queueWithIndex = downloads.queue.map((item, index) => ({ item, index }));
		const ready = queueWithIndex.filter(({ item }) => (item.lastTriedAt || 0) <= now);
		if (!ready.length) {
			const nextRetryAt = Math.min(
				...queueWithIndex
					.map(({ item }) => item.lastTriedAt || 0)
					.filter((retryAt) => retryAt > now)
			);
			if (Number.isFinite(nextRetryAt)) {
				retryWakeTimerRef.current = window.setTimeout(() => {
					setQueueWakeTick((tick) => tick + 1);
				}, Math.max(50, nextRetryAt - now));
			}
			return;
		}

		const selected = ready.slice(0, availableSlots);
		const indicesToStart = new Set(selected.map(({ index }) => index));
		const toStart = selected.map(({ item }) => enrichForDownload(item));
		if (!toStart.length) return;

		setDownloads((prev) => ({
			...prev,
			queue: prev.queue.filter((_, index) => !indicesToStart.has(index)),
			downloading: [...prev.downloading, ...toStart],
		}));

		toStart.forEach((item) => {
			const key = item.key || getDownloadKey(item);
			if (startedKeysRef.current.has(key)) return;
			startedKeysRef.current.add(key);
			void startDownload(item);
		});
	}, [
		dlSettings.maxConcurrentDownloads,
		downloads.downloading.length,
		downloads.queue,
		enrichForDownload,
		queueWakeTick,
		setDownloads,
		startDownload,
	]);

	useEffect(() => {
		const setupListeners = async () => {
			const unlistenProgress = await listen("download-progress", (event) => {
				const payload = event.payload as any;
				const key = String(payload.key || "");
				if (!key) return;

				const total = Number(payload.total || 0);
				const downloaded = Number(payload.downloaded || 0);
				const percent = total > 0 ? Math.max(0, Math.min(100, (downloaded / total) * 100)) : 0;
				const text = ` - ${percent.toFixed(2)}% (${formatBytes(downloaded)}/${formatBytes(total || downloaded)}) - ${
					payload.speed || "-"
				} - ${payload.eta || "-"}`;

				progressRef.current[key] = { percent, text };

				const firstKey = downloadsRef.current.downloading[0]?.key;
				if (firstKey && firstKey === key) {
					if (downloadRef.current) downloadRef.current.style.width = `${percent}%`;
					if (downloadRef2.current) downloadRef2.current.style.width = `${percent}%`;
					if (downloadRef3.current) {
						downloadRef3.current.style.background = `conic-gradient( var(--accent) 0% ${percent}%, var(--button) 0% 100%)`;
					}
				}

				if (dialogOpen || (firstKey && firstKey === key)) {
					scheduleProgressRefresh();
				}
			});

				const unlistenExt = await listen("ext", (event) => {
					const payload = event.payload as any;
					const key = String(payload.key || "");
					if (!key) return;
					delete progressRef.current[key];

					setDownloads((prev) => {
					const finished = prev.downloading.find((item) => item.key === key);
					if (!finished) return prev;
					extracts[key] = finished;
					return {
						...prev,
						downloading: prev.downloading.filter((item) => item.key !== key),
						extracting: [...prev.extracting, finished],
					};
				});
			});

			const unlistenFin = await listen("fin", async (event) => {
				const payload = event.payload as any;
				const key = String(payload.key || "");
				const type = String(payload.type || "auto");
				if (!key) return;

				info("[IMM] Extraction finished for key:", key);
				const finished = extracts[key] || downloadsRef.current.extracting.find((item) => item.key === key);
				delete extracts[key];
				delete progressRef.current[key];

				if (!finished) {
					setDownloads((prev) => ({
						...prev,
						extracting: prev.extracting.filter((item) => item.key !== key),
					}));
					return;
				}

				if (type === "auto") {
					await validateModDownload(finished.dlPath || "");
					setData((prev) => {
						if (finished.path) {
							prev[finished.path] = {
								...prev[finished.path],
								source: finished.source,
								updatedAt: finished.updatedAt || Date.now(),
								viewedAt: Date.now(),
							};
						}
						return { ...prev };
					});
					setDownloads((prev) => ({
						...prev,
						completed: [...prev.completed, { ...finished, status: "completed" }],
						extracting: prev.extracting.filter((item) => item.key !== key),
					}));
					modList(await refreshModList());
				} else {
					await validateModDownload(finished.dlPath || "", true);
					setDownloads((prev) => ({
						...prev,
						completed: [...prev.completed, { ...finished, status: "completed" }],
						extracting: prev.extracting.filter((item) => item.key !== key),
					}));
				}
			});

			const unlistenError = await listen("download-error", (event) => {
				const payload = event.payload as any;
				const key = String(payload.key || "");
				if (!key) return;
				const message = String(payload.message || "Unknown download error");
				const stage = String(payload.stage || "download");
				handleDownloadFailure(key, message, stage);
			});

			return [unlistenProgress, unlistenExt, unlistenFin, unlistenError];
		};

		let unlisteners: Array<() => void> = [];
		void setupListeners().then((fns) => {
			unlisteners = fns;
		});

		return () => {
			unlisteners.forEach((unlisten) => unlisten());
		};
	}, [dialogOpen, handleDownloadFailure, modList, scheduleProgressRefresh, setData, setDownloads]);

	useEffect(() => {
		return () => {
			if (persistTimerRef.current) {
				window.clearTimeout(persistTimerRef.current);
			}
			if (retryWakeTimerRef.current) {
				window.clearTimeout(retryWakeTimerRef.current);
			}
			if (progressFrameRef.current !== null) {
				window.cancelAnimationFrame(progressFrameRef.current);
			}
		};
	}, []);

	useEffect(() => {
		progressRef.current = {};
		extracts = {};
		cancelRequestedRef.current.clear();
		startedKeysRef.current.clear();
		setDownloads((prev) => ({
			...prev,
			downloading: [],
			extracting: [],
			queue: [
				...prev.queue,
				...prev.downloading.map((item) => ({ ...item, status: "pending" as const })),
				...prev.extracting.map((item) => ({ ...item, status: "pending" as const })),
			],
		}));
	}, [game, setDownloads]);

	const clearCompleted = () => {
		setDownloads((prev) => ({ ...prev, completed: [], failed: [] }));
	};

	const retryFailedDownloads = useCallback(() => {
		setDownloads((prev) => {
			if (!prev.failed.length) return prev;
			const now = Date.now();
			const retried = prev.failed.map((item) => {
				const {
					lastError: _lastError,
					key: _oldKey,
					path: _oldPath,
					dlPath: _oldDlPath,
					safeName: _oldSafeName,
					...rest
				} = item;
				return {
					...rest,
					status: "pending" as const,
					requeueRounds: 0,
					lastTriedAt: now,
					displayName: item.displayName || item.name,
				};
			});
			return {
				...prev,
				queue: [...prev.queue, ...retried],
				failed: [],
			};
		});
	}, [setDownloads]);

	const cancelExtract = (key: string) => {
		void invoke("cancel_extract", { key }).then(() => {
			setDownloads((prev) => ({
				...prev,
				extracting: prev.extracting.filter((item) => item.key !== key),
			}));
		});
	};

		const cancelItem = (item: DownloadRow) => {
			if (item.status === "downloading" && item.key) {
				cancelRequestedRef.current.add(item.key);
				delete extracts[item.key];
				delete progressRef.current[item.key];
				void invoke("cancel_download", { key: item.key }).catch(() => {});
			if (item.dlPath) void cleanCancelledDownload(item.dlPath);
			setDownloads((prev) => ({
				...prev,
				downloading: prev.downloading.filter((x) => x.key !== item.key),
			}));
			return;
		}

		if (item.status === "extracting" && item.key) {
			cancelExtract(item.key);
			return;
		}

		if (item.status === "pending") {
			setDownloads((prev) => ({
				...prev,
				queue: prev.queue.filter((x) => !sameDownload(x, item)),
			}));
			return;
		}

		if (item.status === "completed") {
			setDownloads((prev) => ({
				...prev,
				completed: prev.completed.filter((x) => !sameDownload(x, item)),
			}));
			return;
		}

		if (item.status === "failed") {
			setDownloads((prev) => ({
				...prev,
				failed: prev.failed.filter((x) => !sameDownload(x, item)),
			}));
		}
	};

	const downloadList = useMemo(() => {
		const downloadingRows = downloads.downloading.map((item) => ({ ...item, status: "downloading" as const }));
		const extractingRows = downloads.extracting.map((item) => ({ ...item, status: "extracting" as const }));
		const queueRows = downloads.queue.map((item) => ({ ...item, status: "pending" as const }));
		const failedRows = downloads.failed.map((item) => ({ ...item, status: "failed" as const }));
		const completedRows = downloads.completed.map((item) => ({ ...item, status: "completed" as const }));
		return [...downloadingRows, ...extractingRows, ...queueRows, ...failedRows, ...completedRows];
	}, [downloads.completed, downloads.downloading, downloads.extracting, downloads.failed, downloads.queue]);

	const firstItem = downloadList[0];
	const firstProgress = firstItem?.key ? progressRef.current[firstItem.key] || EMPTY_PROGRESS : EMPTY_PROGRESS;
	const firstDownloadingKey = downloads.downloading[0]?.key || "";
	const done = downloads.completed.length + downloads.failed.length;
	const downloadingCount = downloads.downloading.length;
	const headerProgress = firstItem?.status === "downloading" ? firstProgress.percent : 0;
	void progressTick;

	return (
		<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
			<DialogTrigger asChild>
				<Button
					className="text-ellipsis min-h-12 max-h-12 min-w -80 flex flex-col items-center w-full px-0 overflow-hidden"
					style={{ width: leftSidebarOpen ? "" : "3rem" }}
				>
					{leftSidebarOpen ? (
						downloadList.length > 0 ? (
							<div className="fade-in min-h-12 flex flex-col items-center justify-center w-full overflow-hidden rounded-md pointer-events-none">
								<div
									ref={downloadRef}
									key={"down" + JSON.stringify(downloadList[0])}
									className="min-h-12 height-in zzz-rounded bg-accent bgaccent text-background hover:brightness-125 z-10 flex flex-col self-start justify-center -mb-12 overflow-hidden rounded-lg"
									style={{ width: headerProgress + "%" }}
								>
									<div className="min-w-79 fade-in flex items-center justify-center gap-1 pointer-events-none">
										{Icons[firstItem?.status as keyof typeof Icons] || <FileQuestionIcon className="min-h-4 min-w-4" />}
										<Label className="min-w-2 max-w-71.5 w-fit py-2 pr-2" style={{ backgroundColor: "#fff0" }}>
											{firstItem?.status == "downloading"
												? `${textData._LeftSideBar._components._Downloads.Downloading} ${done + downloadingCount}/${
														downloadList.length
													}`
												: `${textData._LeftSideBar._components._Downloads.Downloaded} ${done}/${downloadList.length}`}
										</Label>
									</div>
								</div>
								<div key={"down2" + JSON.stringify(downloadList[0])} className="fade-in min-h-12 flex items-center justify-center w-full gap-1 pointer-events-none">
									{Icons[firstItem?.status as keyof typeof Icons] || <FileQuestionIcon className="min-h-4 min-w-4" />}
									<Label className="w-fit max-w-72 pr-2 pointer-events-none">
										{firstItem?.status == "downloading"
											? `${textData._LeftSideBar._components._Downloads.Downloading} ${done + downloadingCount}/${
													downloadList.length
												}`
											: `${textData._LeftSideBar._components._Downloads.Downloaded} ${done}/${downloadList.length}`}
									</Label>
								</div>
							</div>
						) : (
							<div className="fade-in min-h-12 flex items-center justify-center w-full gap-1 pl-2 pointer-events-none">
								<DownloadIcon className="min-h-4 min-w-4" />
								<Label className="w-fit max-w-72 pr-2 pointer-events-none">{textData.Downloads}</Label>
							</div>
						)
					) : downloadList.length > 0 ? (
						<div
							ref={downloadRef3}
							className="min-h-12 min-w-12 max-w-12 max-h-12 flex items-center justify-center p-1 rounded-lg"
							style={{
								background: `conic-gradient( var(--accent) 0% ${headerProgress}%, var(--button) 0% 100%)`,
								transition: "minHeight 0.3s, margin-bottom 0.3s, height 0.3s",
							}}
						>
							<Label className="bg-button zzz-rounded zzz-fg-text text-accent flex items-center justify-center w-full h-full rounded-md pointer-events-none">{`${
								done + downloadingCount
							}/${downloadList.length}`}</Label>
						</div>
					) : (
						<div className="min-h-12 min-w-12 flex items-center justify-center rounded-md">
							<DownloadIcon className="min-h-4 min-w-4" />
						</div>
					)}
				</Button>
			</DialogTrigger>
			<DialogContent className="min-w-180 min-h-150">
				<div className="min-h-fit text-accent my-6 text-3xl">{textData.Downloads}</div>
				<div className="h-116 flex flex-col items-center w-full gap-4 p-0">
					<div className="flex justify-between w-full">
						<div className="text-accent text-lg">{`${textData._LeftSideBar._components._Downloads.Queue} (${downloadList.length})`}</div>
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={retryFailedDownloads}
								style={{ backgroundColor: "#0000" }}
								disabled={!downloads.failed.length}
							>
								<RotateCcw className="w-3.5 h-3.5 mr-1" />
								{textData._Main._components._Updater.Retry} ({downloads.failed.length})
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={clearCompleted}
								style={{ backgroundColor: "#0000" }}
								disabled={!downloadList.some((item) => item.status === "completed" || item.status === "failed")}
							>
								{textData._LeftSideBar._components._Downloads.Clear}
							</Button>
						</div>
					</div>
					<div className="data-wuwa:gap-0 data-wuwa:border flex flex-col w-full h-full gap-2 overflow-y-auto text-gray-300 border-0 rounded-sm">
						{downloadList.length > 0 ? (
							<>
								<div
									className="button-like zzz-fg-text data-gi:rounded-sm duration-0 min-h-16 data-wuwa:-mb-16 -mb-18 data-wuwa:border-b flex items-center w-full h-16 min-w-0 overflow-hidden"
									style={{ opacity: firstItem?.status === "downloading" ? 1 : 0 }}
								>
									<div
										key={"cur" + JSON.stringify(firstItem)}
										ref={downloadRef2}
										className="bg-accent bgaccent data-zzz:zzz-rounded zzz-fg-text data-gi:rounded-sm duration-0 min-h-16 flex items-center w-0 h-16 min-w-0 opacity-50"
										style={{ width: `${headerProgress}%` }}
									></div>
								</div>
								{downloadList.map((item, index) => {
									const itemProgress = item.key ? progressRef.current[item.key] || EMPTY_PROGRESS : EMPTY_PROGRESS;
									return (
										<div
											key={(item.key || (item.displayName || item.name).replaceAll("DISABLED_", "")) + index}
											className="hover:bg-background/20 zzz-fg-text data-gi:border-1 data-gi:rounded-sm min-h-16 data-wuwa:border-b button-like flex items-center justify-between w-full px-4"
											style={{ backgroundColor: index % 2 == 0 ? "#1b1b1b50" : "#31313150" }}
										>
											<div className="flex items-center flex-1 w-full gap-3">
												{Icons[item.status as keyof typeof Icons] || <FileQuestionIcon className="min-h-4 min-w-4" />}
												<div className="flex flex-col flex-1 w-full">
													<Label
														className="focus:border-0 border-border/0 max-w-142 text-ellipsis w-full h-8 overflow-hidden text-white rounded-none cursor-default pointer-events-none"
														style={{ backgroundColor: "#fff0" }}
													>
														{(item.displayName || item.name).replaceAll("DISABLED_", "")}
													</Label>
													<div className="flex gap-1 text-xs text-gray-400 capitalize">
														{`${item.status + (item.status === "extracting" ? ` ${item.fname}` : "")}`}
														<div>
															{item.status === "downloading" && item.key === firstDownloadingKey
																? itemProgress.text
																: item.lastError
																	? ` - ${item.lastError}`
																	: ""}
														</div>
														{item.category}
													</div>
												</div>
											</div>
											<div className="flex items-center gap-2 z-20">
												{(item.status === "pending" ||
													item.status === "completed" ||
													item.status === "failed" ||
													item.status === "downloading") && (
													<Button
														variant="ghost"
														size="sm"
														onClick={() => cancelItem(item)}
														className={item.status === "completed" || item.status === "failed" ? "hover:text-gray-300 data-zzz:border-0 text-gray-400" : "hover:text-destructive"}
													>
														<X className="w-4 h-4" />
													</Button>
												)}
												{item.status === "extracting" && (
													<Button variant="ghost" size="sm" onClick={() => cancelExtract(item.key || "")} className="hover:text-destructive">
														<X className="w-4 h-4" />
													</Button>
												)}
											</div>
										</div>
									);
								})}
							</>
						) : (
							<div className="flex items-center justify-center h-full text-gray-400">
								{textData._LeftSideBar._components._Downloads.NoQ}
							</div>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export default Downloads;
