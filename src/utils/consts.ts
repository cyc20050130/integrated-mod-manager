import TEXT from "@/textData.json";
import {
	Category,
	ChangeInfo,
	DownloadItem,
	Games,
	InstalledItem,
	LinkAuditReport,
	Language,
	Mod,
	ModDataObj,
	NteRegion,
	OnlineData,
	PreviewBackfillState,
	Preset,
	Settings,
} from "./types";
import { info } from "@/lib/logger";
import { GAME_REGISTRY } from "./gameRegistry";

export const OLD_RESTORE = "DISABLED_RESTORE";
export const RESTORE = "RESTORE";
export const IGNORE = "IGNORE";
export const PREFS = ".USER_PREFS";
export const DISCORD_LINK = "https://discord.gg/QGkKzNapXZ";
export const BANANA_LINK = "https://gamebanana.com/mods/593490";
export const UNCATEGORIZED = "Uncategorized";
export const OLD_managedSRC = "DISABLED (Managed by IMM)";
export const OLD_managedTGT = "Mods (Managed by IMM)";
export const managedSRC = "DISABLED - ALL MODS ARE STORED HERE (Managed by IMM)";
export const managedTGT = "DO NOT MODIFY (Managed by IMM)";
export const VERSION = "3.2.20";
export const GAMES: Games[] = Object.keys(GAME_REGISTRY) as Games[];
export const GAME_GB_IDS: { [key: number]: Games } = {
	...Object.fromEntries(Object.values(GAME_REGISTRY).map((entry) => [entry.gameBananaId, entry.key])),
	0: "",
};
export const GAME_NAMES: { [key in Games]: string } = {
	...Object.fromEntries(Object.values(GAME_REGISTRY).map((entry) => [entry.key, entry.displayName])),
	"": "Integrated",
} as { [key in Games]: string };
export const exts = ["png", "jpg", "jpeg", "webp", "gif"];
export const PRIORITY_KEYS = ["Alt", "Ctrl", "Shift", "Capslock", "Tab", "Up", "Down", "Left", "Right"] as const;
export const LANG_LIST: { Name: string; Flag: string; Code: Language }[] = [
	{
		Name: TEXT.en.Current,
		Flag: TEXT.en.Flag,
		Code: "en",
	},
	{
		Name: TEXT.cn.Current,
		Flag: TEXT.cn.Flag,
		Code: "cn",
	},
	{
		Name: TEXT.ru.Current,
		Flag: TEXT.ru.Flag,
		Code: "ru",
	},
	{
		Name: TEXT.jp.Current,
		Flag: TEXT.jp.Flag,
		Code: "jp",
	},
	{
		Name: TEXT.kr.Current,
		Flag: TEXT.kr.Flag,
		Code: "kr",
	},
];
export const ONLINE_TRANSITION = (online: boolean, move = false) => ({
	initial: { opacity: 0, x: move ? (online ? "25%" : "-25%") : 0 },
	animate: { opacity: 1, x: 0 },
	exit: { opacity: 0, x: move ? (online ? "25%" : "-25%") : 0 },
	transition: { duration: 0.2 },
});
export const GAME_ID_MAP: { [key: string]: number } = Object.fromEntries(
	Object.values(GAME_REGISTRY).map((entry) => [entry.key, entry.serializedId])
);
export const DEFAULTS = {
	INIT_DONE: false,
	LANG: "en" as Language,
	GAME: "" as Games,
	SETTINGS: {
		global: {
			bgOpacity: 1,
			winOpacity: 1,
			winType: 0,
			bgType: 2,
			listType: 0,
			nsfw: 1,
			toggleClick: 2,
			ignore: "",
			clientDate: "1759866302559426603",
			XXMI: "",
			lang: "",
			game: "",
			preReleases: false,
			chkModUpdates: true,
			onlineBlacklist: [],
			wuwaModFixer: {
				version: "",
				exePath: "",
				checkedAt: 0,
				releaseUrl: "",
			},
		},
		game: {
			launch: 0,
			hotReload: 1,
			onlineType: "Mod",
			customCategories: {},
			download: {
				maxConcurrentDownloads: 1,
				maxConcurrentExtracts: 2,
				requestRetries: 3,
				connectTimeoutSec: 10,
				stallTimeoutSec: 25,
				maxRequeueRounds: 3,
				progressIntervalMs: 700,
				progressBytesThresholdKB: 256,
				backoffBaseMs: 2000,
			},
		},
	} as Settings,
	SOURCE: "",
	TARGET: "",
	XXMI_MODE: 0 as 0 | 1,
	NTE_REGION: "auto" as NteRegion,
	DATA: {} as ModDataObj,
	PRESETS: [] as Preset[],
	CATEGORIES: [] as Category[],
	TYPES: [] as Category[],
	CHANGES: { before: [], after: [], map: {}, skip: false, title: "" } as ChangeInfo,
	DOWNLOAD_LIST: {
		...{
			queue: [] as DownloadItem[],
			downloading: [] as DownloadItem[],
			completed: [] as DownloadItem[],
			extracting: [] as DownloadItem[],
			failed: [] as DownloadItem[],
		},
	},
	ONLINE: false,
	CURRENT_PRESET: -1,
	MOD_LIST: [] as Mod[],
	SELECTED: "",
	FILTER: {
		st: "all",
		src: "any",
		tag: {
			fav: "any",
			nsfw: "any",
		},
		upd: "any",
	} as Record<string, string | { [key: string]: string }>,
	SORT: "default",
	CATEGORY: new Set([]) as Set<string>,
	SEARCH: "",
	INSTALLED_ITEMS: [] as InstalledItem[],
	ONLINE_DATA: {} as OnlineData,
	ONLINE_SOURCE: "all" as const,
	ONLINE_TYPE: "Mod",
	ONLINE_SORT: "",
	ONLINE_PATH: "home&type=Mod",
	ONLINE_SELECTED: "",
	LINK_AUDIT_REPORT: null as LinkAuditReport | null,
	LINK_AUDIT_RUNNING: false,
	PREVIEW_BACKFILL_STATE: {
		running: false,
		queued: 0,
		completed: 0,
		failed: 0,
		skippedCooldown: 0,
		lastRunAt: 0,
	} as PreviewBackfillState,
};
export const SORT_OPTIONS = Object.fromEntries(
	[
		{
			label: "Default",
			value: "default",
		},
		// {
		// 	label: "A-Z",
		// 	value: "alpha-asc",
		// },
		// {
		// 	label: "Z-A",
		// 	value: "alpha-desc",
		// },
		{
			label: "Favourite ↑",
			value: "fav-asc",
		},
		{
			label: "Favourite ↓",
			value: "fav-desc",
		},
		// {
		// 	label: "Source ↑",
		// 	value: "src-asc",
		// },
		// {
		// 	label: "Source ↓",
		// 	value: "src-desc",
		// },
		// {
		// 	label: "NSFW ↑",
		// 	value: "nsfw-asc",
		// },
		// {
		// 	label: "NSFW ↓",
		// 	value: "nsfw-desc",
		// },
		// {
		// 	label: "Enabled ↑",
		// 	value: "en-asc",
		// },
		// {
		// 	label: "Enabled ↓",
		// 	value: "en-desc",
		// },
	].map((opt) => [opt.value, opt.label])
);
info(SORT_OPTIONS);
