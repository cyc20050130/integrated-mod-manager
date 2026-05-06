import { atom, createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
export const store = createStore();
import TEXT from "@/textData.json";
import { DEFAULTS, VERSION } from "./consts";
import {
	Category,
	ChangeInfo,
	DownloadList,
	Games,
	InstalledItem,
	LinkAuditReport,
	Language,
	Mod,
	ModDataObj,
	OnlineData,
	Preset,
	PreviewBackfillState,
	ProgressData,
	Settings,
} from "./types";

interface UpdateInfo {
	version: string;
	status: "checking" | "up_to_date" | "available" | "downloading" | "installing" | "relaunching" | "error";
	date: string;
	body: string;
	raw: UpdateHandle | null;
	error?: string;
}
interface UpdateDownloadEvent {
	event: string;
	data?: {
		contentLength?: number;
		chunkLength?: number;
	};
}
interface UpdateHandle {
	download(callback?: (event: UpdateDownloadEvent) => void, options?: unknown): Promise<void>;
	install(): Promise<void>;
}
interface ToastInfo {
	id: number;
	type: "success" | "error" | "info" | "warning";
	message: string;
	onClick: null | (() => void);
}
interface NoticeInfo {
	heading: string;
	subheading: string;
	ignoreable: number;
	timer: number;
	ver: string;
	id: number;
}
const INIT_DONE = atom(false);
const MAIN_FUNC_STATUS = atom<string>("");
const FIRST_LOAD = atom(false);
const GAME = atom<Games>("");
const LANG = atom<Language>("en");
const SAVED_LANG = atomWithStorage<Language | "">("imm-lang","");
const LAST_UPDATED = atom(Date.now());
const SETTINGS = atom<Settings>({
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
});
const SOURCE = atom<string>("");
const TARGET = atom<string>("");
const DATA = atom<ModDataObj>({});
const PRESETS = atom<Preset[]>([]);
const CATEGORIES = atom<Category[]>([]);
const TYPES = atom<Category[]>([]);
const XXMI_MODE = atom<0 | 1>(0);
const XXMI_DIR = atom<string>("");
const LEFT_SIDEBAR_OPEN = atom(true);
const RIGHT_SIDEBAR_OPEN = atom(true);
const RIGHT_SLIDEOVER_OPEN = atom(false);
const ONLINE = atom(false);
const DOWNLOAD_LIST = atom<DownloadList>(DEFAULTS.DOWNLOAD_LIST);
const CURRENT_PRESET = atom(DEFAULTS.CURRENT_PRESET);
const MOD_LIST = atom<Mod[]>(DEFAULTS.MOD_LIST);
const SELECTED = atom(DEFAULTS.SELECTED);
const FILTER = atom(DEFAULTS.FILTER);
const SORT = atom(DEFAULTS.SORT);
const CATEGORY = atom(DEFAULTS.CATEGORY);
const SEARCH = atom(DEFAULTS.SEARCH);
const INSTALLED_ITEMS = atom<InstalledItem[]>(DEFAULTS.INSTALLED_ITEMS);
const ONLINE_DATA = atom<OnlineData>(DEFAULTS.ONLINE_DATA);
const ONLINE_SOURCE = atom(DEFAULTS.ONLINE_SOURCE);
const ONLINE_TYPE = atom(DEFAULTS.ONLINE_TYPE);
const ONLINE_SORT = atom(DEFAULTS.ONLINE_SORT);
const ONLINE_PATH = atom(DEFAULTS.ONLINE_PATH);
const ONLINE_SELECTED = atom(DEFAULTS.ONLINE_SELECTED);
const TOASTS = atom<ToastInfo[]>([]);
const CHANGES = atom<ChangeInfo>({
	before: [],
	after: [],
	map: {},
	skip: false,
	title: "",
});
const TEXT_DATA = atom(TEXT["en"]);
const PROGRESS_OVERLAY = atom<ProgressData>({ title: "", open: false, finished: false, button: "", name: "" });
const IMM_UPDATE = atom(null as UpdateInfo | null);
const UPDATER_OPEN = atom(false);
const WUWA_MOD_FIXER_OPEN = atom(false);
const NOTICE = atom<NoticeInfo>({
	heading: "",
	subheading: "",
	ignoreable: 2,
	timer: 10,
	ver: VERSION,
	id: 0,
});
const HELP_OPEN = atom(false);
const TUTORIAL_OPEN = atom(false);
const NOTICE_OPEN = atom(false);
const REMOVE_OPEN = atom(false);
const CONFLICTS_OPEN = atom(false);
const CONFLICTS = atom({
	conflicts: [] as string[][],
	mods: {} as Record<string, number>,
});
const CONFLICT_INDEX = atom(0);
export function openConflict(index=-1) {
	store.set(CONFLICTS_OPEN, (prev) => {
		if (!prev && index>=0) {
			store.set(CONFLICT_INDEX, index);
		}
		return true;
	});
}
const FILE_TO_DL = atom("");
const LINK_AUDIT_REPORT = atom<LinkAuditReport | null>(DEFAULTS.LINK_AUDIT_REPORT);
const LINK_AUDIT_RUNNING = atom<boolean>(DEFAULTS.LINK_AUDIT_RUNNING);
const PREVIEW_BACKFILL_STATE = atom<PreviewBackfillState>(DEFAULTS.PREVIEW_BACKFILL_STATE);
export function resetAtoms() {
	store.set(FILE_TO_DL, "");
	store.set(INIT_DONE, DEFAULTS.INIT_DONE);
	store.set(LANG, DEFAULTS.LANG);
	store.set(GAME, DEFAULTS.GAME);
	store.set(SETTINGS, DEFAULTS.SETTINGS);
	store.set(SOURCE, DEFAULTS.SOURCE);
	store.set(TARGET, DEFAULTS.TARGET);
	store.set(DATA, DEFAULTS.DATA);
	store.set(PRESETS, DEFAULTS.PRESETS);
	store.set(CATEGORIES, DEFAULTS.CATEGORIES);
	store.set(TYPES, DEFAULTS.TYPES);
	store.set(CHANGES, DEFAULTS.CHANGES);
	store.set(ONLINE, DEFAULTS.ONLINE);
	store.set(DOWNLOAD_LIST, DEFAULTS.DOWNLOAD_LIST);
	store.set(CURRENT_PRESET, DEFAULTS.CURRENT_PRESET);
	store.set(MOD_LIST, DEFAULTS.MOD_LIST);
	store.set(SELECTED, DEFAULTS.SELECTED);
	store.set(FILTER, DEFAULTS.FILTER);
	store.set(CATEGORY, DEFAULTS.CATEGORY);
	store.set(SEARCH, DEFAULTS.SEARCH);
	store.set(SORT, DEFAULTS.SORT);
	store.set(INSTALLED_ITEMS, DEFAULTS.INSTALLED_ITEMS);
	store.set(ONLINE_DATA, DEFAULTS.ONLINE_DATA);
	store.set(ONLINE_SOURCE, DEFAULTS.ONLINE_SOURCE);
	store.set(ONLINE_TYPE, DEFAULTS.ONLINE_TYPE);
	store.set(ONLINE_PATH, DEFAULTS.ONLINE_PATH);
	store.set(ONLINE_SORT, DEFAULTS.ONLINE_SORT);
	store.set(ONLINE_SELECTED, DEFAULTS.ONLINE_SELECTED);
	store.set(XXMI_MODE, DEFAULTS.XXMI_MODE);
	store.set(LINK_AUDIT_REPORT, DEFAULTS.LINK_AUDIT_REPORT);
	store.set(LINK_AUDIT_RUNNING, DEFAULTS.LINK_AUDIT_RUNNING);
	store.set(PREVIEW_BACKFILL_STATE, DEFAULTS.PREVIEW_BACKFILL_STATE);
}
const ERR = atom("");
export {
	CONFLICTS,
	FILE_TO_DL,
	LINK_AUDIT_REPORT,
	LINK_AUDIT_RUNNING,
	PREVIEW_BACKFILL_STATE,
	ERR,
	XXMI_DIR,
	XXMI_MODE,
	FIRST_LOAD,
	HELP_OPEN,
	WUWA_MOD_FIXER_OPEN,
	TUTORIAL_OPEN,
	NOTICE,
	NOTICE_OPEN,
	REMOVE_OPEN,
	UPDATER_OPEN,
	CONFLICTS_OPEN,
	CONFLICT_INDEX,
	IMM_UPDATE,
	PROGRESS_OVERLAY,
	TOASTS,
	CURRENT_PRESET,
	INSTALLED_ITEMS,
	RIGHT_SLIDEOVER_OPEN,
	DOWNLOAD_LIST,
	TYPES,
	ONLINE_DATA,
	ONLINE_SOURCE,
	ONLINE_TYPE,
	ONLINE_PATH,
	ONLINE_SORT,
	ONLINE_SELECTED,
	CATEGORY,
	SEARCH,
	FILTER,
	GAME,
	INIT_DONE,
	MAIN_FUNC_STATUS,
	LANG,
	SAVED_LANG,
	SETTINGS,
	TEXT_DATA,
	SOURCE,
	TARGET,
	DATA,
	PRESETS,
	CATEGORIES,
	CHANGES,
	MOD_LIST,
	ONLINE,
	LEFT_SIDEBAR_OPEN,
	RIGHT_SIDEBAR_OPEN,
	LAST_UPDATED,
	SELECTED,
	SORT,
};
