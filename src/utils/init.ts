import {
	BOOTSTRAP_STATE,
	CATEGORIES,
	DATA,
	DOWNLOAD_LIST,
	ERR,
	FIRST_LOAD,
	GAME,
	IMM_UPDATE,
	LANG,
	MAIN_FUNC_STATUS,
	NOTICE,
	NOTICE_OPEN,
	NTE_REGION,
	ONLINE_DATA,
	PRESETS,
	resetAtoms,
	SAVED_LANG,
	SETTINGS,
	SOURCE,
	store,
	TARGET,
	TEXT_DATA,
	TYPES,
	UPDATER_OPEN,
	XXMI_DIR,
	XXMI_MODE,
} from "./vars";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { path } from "@tauri-apps/api";
import { invoke } from "@tauri-apps/api/core";
// import { currentMonitor, PhysicalSize } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import defConfig from "../default.json";
import defConfigXX from "../defaultXX.json";
import defConfigNTE from "../defaultNTE.json";
import { getGameBananaProvider, runServiceHealthCheckOnce } from "./api";
import { GAMES, VERSION } from "./consts";
import { switchGameTheme } from "./theme";
import { executeXXMI, isGameProcessRunning } from "./autolaunch";
// import { updateIni } from "./iniUpdater";
import { join, setHotreload, stopWindowMonitoring } from "./hotreload";
import { registerGlobalHotkeys } from "./hotkeyUtils";
import TEXT from "@/textData.json";
import { unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { compareVersions, safeLoadJson, sanitizeGlobalSettings } from "./utils";
import { addToast } from "@/_Toaster/ToastProvider";
import {
	Category,
	DownloadList,
	GameSettings,
	Games,
	GlobalSettings,
	ModDataObj,
	NteRegion,
	Preset,
	RuntimeBootstrapState,
	Settings,
} from "./types";
import { toResumableDownloadList, withNormalizedDownloadSettings } from "./downloads";
import { resetPageCounts } from "@/_Main/MainOnline";
import { error, info } from "@/lib/logger";
import { syncIniStateOnce } from "./iniStateSync";
import { getManagedConfigTarget, readManagedConfigText, writeManagedConfigText } from "./appConfigRepository";
// import { v2_0_4_migration } from "./filesys";

type RuntimeGlobalConfig = GlobalSettings & { version?: string; updatedAt?: string; notice?: number };
type RuntimeGameConfig = {
	version: string;
	game: Games;
	custom: 0 | 1;
	nteRegion?: NteRegion;
	sourceDir: string;
	targetDir: string;
	settings: GameSettings;
	data: ModDataObj;
	downloads: DownloadList;
	presets: Preset[];
	categories: Category[];
	updatedAt: number | string;
};
type RuntimeGame = Exclude<Games, "">;
type LegacySettings = {
	opacity?: number;
	type?: number;
	bgType?: number;
	nsfw?: number;
	toggle?: number;
	clientDate?: string;
	lang?: string;
	launch?: number;
	hotReload?: number;
	onlineType?: string;
};
type LegacyConfig = {
	version?: string;
	settings?: LegacySettings;
	data?: Record<string, unknown>;
	presets?: Preset[];
};
type XXMIImporter = {
	Importer: {
		importer_folder?: string;
		run_pre_launch: string;
		run_post_load: string;
	};
};
type XXMIConfig = {
	Importers: Record<string, XXMIImporter | undefined>;
};
type UpdateNotice = {
	heading?: string;
	subheading?: string;
	ignoreable?: number;
	timer?: number;
	ver?: string;
	id?: number;
};
type UpdateBodyContent = {
	notice?: UpdateNotice;
	[key: string]: unknown;
};
type NteModsRootValidation = {
	valid: boolean;
	message?: string;
};
type XxmiLauncherConfigDocument = {
	root: string;
	contents: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonText<T>(jsonText: string): T {
	return JSON.parse(jsonText) as T;
}

function normalizeUpdateBodyEntry(value: unknown): UpdateBodyContent {
	return isRecord(value) ? (value as UpdateBodyContent) : {};
}

function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error || "Update check failed");
}

async function safeExists(pathLike: string) {
	const managedConfig = getManagedConfigTarget(pathLike);
	if (!managedConfig) return false;
	try {
		await readManagedConfigText(managedConfig);
		return true;
	} catch {
		return false;
	}
}

async function safeReadTextFile(pathLike: string) {
	const managedConfig = getManagedConfigTarget(pathLike);
	if (!managedConfig) throw new Error(`Unsupported managed configuration target: ${pathLike}`);
	return readManagedConfigText(managedConfig);
}

async function safeWriteTextFile(pathLike: string, contents: string) {
	const managedConfig = getManagedConfigTarget(pathLike);
	if (!managedConfig) throw new Error(`Unsupported managed configuration target: ${pathLike}`);
	await writeManagedConfigText(managedConfig, contents);
	return true;
}

async function managedGameRootExists(game: RuntimeGame, rootKind: "source" | "target") {
	try {
		return await invoke<boolean>("managed_path_exists", { game, rootKind, relativePath: "" });
	} catch (error) {
		info(`[IMM] persisted ${game} ${rootKind} is unavailable:`, error);
		return false;
	}
}

async function configuredXxmiIsReadable() {
	try {
		await invoke<XxmiLauncherConfigDocument>("read_xxmi_launcher_config");
		return true;
	} catch {
		return false;
	}
}

let paths = {
	"": "",
	exe: "",
	WW: "",
	ZZ: "",
	GI: "",
	SR: "",
	XX: "",
	EF: "",
	NTE: "",
};
let isInPrePostLaunch = {
	WW: false,
	ZZ: false,
	GI: false,
	SR: false,
	EF: false,
	NTE: false,
	"": false,
};

export function getPaths() {
	return paths;
}
let config: RuntimeGlobalConfig = sanitizeGlobalSettings({ ...defConfig }) as RuntimeGlobalConfig;
let configXX: RuntimeGameConfig = { ...defConfigXX } as RuntimeGameConfig;
let dataDir = "";
let prevGame = "";
let categories: Category[] = [];
let isInitialized = false;
let latestBootstrapGeneration = 0;
let bootstrapQueue: Promise<void> = Promise.resolve();

function publishBootstrapState(
	generation: number,
	phase: RuntimeBootstrapState["phase"],
	game: Games,
	stage: string,
	errorMessage: string | null = null
) {
	if (generation !== latestBootstrapGeneration) return store.get(BOOTSTRAP_STATE);
	const nextState: RuntimeBootstrapState = { phase, generation, game, stage, error: errorMessage };
	store.set(BOOTSTRAP_STATE, nextState);
	return nextState;
}

export function completeRuntimeBootstrap(game = store.get(GAME)) {
	const current = store.get(BOOTSTRAP_STATE);
	if (current.generation !== latestBootstrapGeneration) return current;
	if (current.game && game && current.game !== game) return current;
	const readyState = publishBootstrapState(current.generation, "ready", game || current.game, "ready");
	if (readyState.game) {
		void runServiceHealthCheckOnce(readyState.game, config.clientDate || "");
		void setCategories(readyState.game, false, true, readyState.generation).catch((categoryError) => {
			info("[IMM] Background category refresh failed:", categoryError);
		});
	}
	return readyState;
}

export function requestRuntimeConfiguration(stage = "configuration-requested") {
	const current = store.get(BOOTSTRAP_STATE);
	return publishBootstrapState(current.generation, "needsConfiguration", store.get(GAME) || current.game, stage);
}

export function failRuntimeBootstrap(value: unknown, stage = "runtime-error") {
	const current = store.get(BOOTSTRAP_STATE);
	const message = value instanceof Error ? value.message : String(value || "Runtime initialization failed");
	return publishBootstrapState(current.generation, "failed", store.get(GAME) || current.game, stage, message);
}
async function getXXMIConfig(): Promise<{ config: XXMIConfig; root: string } | null> {
	try {
		const document = await invoke<XxmiLauncherConfigDocument>("read_xxmi_launcher_config");
		return { config: readJsonText<XXMIConfig>(document.contents), root: document.root };
	} catch (e) {
		info("[IMM] Failed to read XXMI Launcher config:", e);
		return null;
	}
}
export async function setPrePostLaunch(game: Games, value: boolean) {
	const document = await getXXMIConfig();
	if (!document) return;
	const data = document.config;
	const importer = data.Importers[game + "MI"];
	if (!importer) return;
	const cmd = `start imm://mode/${game.toLowerCase()}`;
	if (value) {
		if (!importer.Importer.run_pre_launch.includes(cmd))
			importer.Importer.run_pre_launch = [cmd, ...importer.Importer.run_pre_launch.split(" && ")]
				.filter((x: string) => x.trim() !== "")
				.join(" && ");
	} else {
		if (importer.Importer.run_pre_launch.includes(cmd)) {
			importer.Importer.run_pre_launch = importer.Importer.run_pre_launch
				.split(" && ")
				.filter((x: string) => x.trim() !== cmd)
				.join(" && ");
		}
		if (importer.Importer.run_post_load.includes(cmd)) {
			importer.Importer.run_post_load = importer.Importer.run_post_load
				.split(" && ")
				.filter((x: string) => x.trim() !== cmd)
				.join(" && ");
		}
	}
	await invoke<void>("write_xxmi_launcher_config", { contents: JSON.stringify(data, null, 2) });
}
export async function readXXMIConfig() {
	paths = {
		"": "",
		exe: "",
		WW: "",
		ZZ: "",
		GI: "",
		SR: "",
		XX: "",
		EF: "",
		NTE: "",
	};
	isInPrePostLaunch = {
		WW: false,
		ZZ: false,
		GI: false,
		SR: false,
		EF: false,
		NTE: false,
		"": false,
	};
	const document = await getXXMIConfig();
	if (document) {
		const data = document.config;
		const path = document.root;
		info("[IMM] Loaded XXMI Launcher config:", data);
		GAMES.forEach((game) => {
			const importer = data.Importers[game + "MI"];
			if (importer) {
				const xxPath = (importer.Importer.importer_folder || "").replace(/\\/g, "/");
				info(`[IMM] Resolved ${game}MI path:`, xxPath);
				paths[game as Games] = xxPath == `${game}MI/` ? join(path, `${game}MI`) : join(...xxPath.split("/"));
				const startCmd = `start imm://mode/${game.toLowerCase()}`;
				if (importer.Importer.run_pre_launch.includes(startCmd) || importer.Importer.run_post_load.includes(startCmd))
					isInPrePostLaunch[game as Games] = true;
			}
		});
		paths.XX = path;
		store.set(XXMI_DIR, path);
	}
	info("[IMM] Resolved game paths:", paths);
}
export function getDataDir() {
	return dataDir;
}
export function getPrevGame() {
	return prevGame;
}
const hasTauriWindowRuntime =
	typeof globalThis !== "undefined" &&
	typeof globalThis.window !== "undefined" &&
	"__TAURI_INTERNALS__" in globalThis.window;

export const window = hasTauriWindowRuntime ? getCurrentWebviewWindow() : null;
export function changeWindowTitle(title: string) {
	window?.setTitle(title);
}
export async function setWindowType(type: number) {
	if (type == 0) {
		// if (await window.isMaximized())
		await window?.unmaximize();
		// window.setFullscreen(false);
		// window.setDecorations(true);
		// currentMonitor().then((x) => {
		// 	if (x?.size) window.setSize(new PhysicalSize(x.size.width * 0.8, x.size.height * 0.8));
		// });
	} else if (type == 1) {
		await window?.unmaximize();
		// window.setFullscreen(false);
		// window.setDecorations(false);
		// currentMonitor().then((x) => {
		// 	if (x?.size) window.setSize(new PhysicalSize(x.size.width * 0.8, x.size.height * 0.8));
		// });
	} else if (type == 2) {
		await window?.maximize();
		// window.setFullscreen(true);
	}
}
export async function updateConfig(oconfig: LegacyConfig | null = null): Promise<RuntimeGlobalConfig> {
	if (!oconfig) oconfig = readJsonText<LegacyConfig>(await safeReadTextFile("config.json"));
	info("[IMM] Updating config from:", oconfig);
	if (compareVersions(oconfig.version || "0.0.0", "2.1.0") >= 0) {
		return sanitizeGlobalSettings(oconfig as RuntimeGlobalConfig) as RuntimeGlobalConfig;
	}
	const legacySettings = oconfig.settings || {};
	const config: RuntimeGlobalConfig = {
		version: VERSION,
		updatedAt: new Date().toISOString(),
		bgOpacity: legacySettings.opacity || 1,
		winOpacity: 1,
		winType: (legacySettings.type || 0) as 0 | 1 | 2,
		bgType: (legacySettings.bgType || 2) as 0 | 1 | 2,
		listType: 0,
		nsfw: (legacySettings.nsfw || 1) as 0 | 1 | 2,
		toggleClick: (legacySettings.toggle || 2) as 0 | 2,
		ignore: "",
		clientDate: legacySettings.clientDate || "",
		XXMI: "",
		lang: (legacySettings.lang || "") as RuntimeGlobalConfig["lang"],
		game: "" as Games,
		preReleases: false,
		chkModUpdates: true,
		onlineBlacklist: [],
		wuwaModFixer: { ...defConfig.wuwaModFixer },
	};
	const data = { ...(oconfig.data || {}) } as Record<string, unknown>;
	const keys = Object.keys(data);
	for (const key of keys) {
		if (key.startsWith("\\")) {
			data[key.substring(1)] = data[key];
			delete data[key];
		}
	}
	const presets = (oconfig.presets || []).map((preset: Preset) => {
		const newPreset: Preset = { name: preset.name || "Preset", data: [], hotkey: preset?.hotkey || "" };
		if (preset.data && Array.isArray(preset.data)) {
			newPreset.data = preset.data.map((item: string) => (item.startsWith("\\") ? item.substring(1) : item));
		}
		return newPreset;
	});
	await safeWriteTextFile(
		`configWW.json`,
		JSON.stringify(
			{
				version: VERSION,
				categories: [],
				settings: {
					launch: (legacySettings.launch || 0) as 0 | 1 | 2,
					hotReload: (legacySettings.hotReload || 1) as 0 | 1 | 2,
					onlineType: legacySettings.onlineType || "Mod",
					customCategories: {},
					download: { ...defConfigXX.settings.download },
				},
				data,
				presets: presets || [],
				downloads: {
					queue: [],
					downloading: [],
					extracting: [],
					completed: [],
					failed: [],
				},
				updatedAt: new Date().getTime(),
			},
			null,
			2
		)
	);
	store.set(FIRST_LOAD, true);
	return config;
}
export async function verifyGameDir(game: Games) {
	const dirs = {
		targetDir: "",
		sourceDir: "",
	};
	try {
		(await invoke<string>("read_xxmi_importer_d3dx", { game })).split("\n").forEach((line: string) => {
			const [key, value] = line.split("=").map((x: string) => x.trim());
			if (key == "include_recursive") {
				const isPath = value.slice(1, 3) == ":\\";
				const importerPath = paths[game];
				dirs.targetDir = isPath ? value : join(importerPath, value);
				dirs.sourceDir = isPath ? value : join(importerPath, value);
			}
		});
	} catch (e) {
		info(`[IMM] Failed to read d3dx.ini for ${game}:`, e);
		dirs.sourceDir = "";
		dirs.targetDir = "";
	}
	return dirs;
}
export async function initGame(game: RuntimeGame, status = true) {
	info(`[IMM] Initializing game: ${game}...`);
	const defaultGameConfig = game === "NTE" ? defConfigNTE : defConfigXX;
	store.set(ONLINE_DATA, {});
	const savedConfig = (await safeExists(`config${game}.json`))
		? readJsonText<Partial<RuntimeGameConfig>>(await safeReadTextFile(`config${game}.json`))
		: {};
	const mergedSettings = {
		...defaultGameConfig.settings,
		...(savedConfig.settings || {}),
		customCategories: {
			...defaultGameConfig.settings.customCategories,
			...(savedConfig.settings?.customCategories || {}),
		},
		download: {
			...defaultGameConfig.settings.download,
			...(savedConfig.settings?.download || {}),
		},
	} as GameSettings;
	configXX = {
		...defaultGameConfig,
		...savedConfig,
		version: VERSION,
		game,
		settings: withNormalizedDownloadSettings(mergedSettings),
		data: (savedConfig.data || {}) as ModDataObj,
		downloads: toResumableDownloadList(savedConfig.downloads || defaultGameConfig.downloads),
		presets: savedConfig.presets || [],
		categories: savedConfig.categories || [],
		custom: game === "NTE" ? 1 : ((savedConfig.custom ?? defaultGameConfig.custom) as 0 | 1),
		...(game === "NTE" ? { nteRegion: (savedConfig.nteRegion ?? "auto") as NteRegion } : {}),
		sourceDir: savedConfig.sourceDir || defaultGameConfig.sourceDir,
		targetDir: savedConfig.targetDir || defaultGameConfig.targetDir,
		updatedAt: savedConfig.updatedAt || (game === "NTE" ? new Date().toISOString() : defaultGameConfig.updatedAt),
	};
	if (configXX.settings.launch === 2 && !isInPrePostLaunch[game]) configXX.settings.launch = 0;
	else if (isInPrePostLaunch[game]) configXX.settings.launch = 2;
	switchGameTheme(game);

	if (game !== "NTE" && !configXX.custom) {
		configXX = { ...configXX, ...(await verifyGameDir(game)) };
	} else {
		dataDir = configXX.targetDir;
	}
	await safeWriteTextFile(`config${game}.json`, JSON.stringify(configXX, null, 2));
	await setCategories(game, status, false, generationForCurrentBootstrap());
	invoke("set_window_icon", { game });
	// Validate source and target dirs
	if (configXX.sourceDir && !(await managedGameRootExists(game, "source"))) configXX.sourceDir = "";
	if (game !== "NTE" && configXX.targetDir && !(await managedGameRootExists(game, "target"))) configXX.targetDir = "";
	if (status) store.set(MAIN_FUNC_STATUS, "Validating source and target directories");
	info("[IMM] Validating source and target directories...", configXX.sourceDir, configXX.targetDir);
	store.set(SOURCE, configXX.sourceDir || "");
	store.set(TARGET, configXX.targetDir || "");
	store.set(XXMI_MODE, (configXX.custom || 0) as 0 | 1);
	store.set(NTE_REGION, configXX.nteRegion || "auto");
	store.set(
		SETTINGS,
		(prev) => ({ global: { ...prev.global, game }, game: { ...prev.game, ...configXX.settings } }) as Settings
	);
	store.set(DATA, configXX.data || ({} as ModDataObj));
	store.set(PRESETS, configXX.presets || []);
	store.set(DOWNLOAD_LIST, toResumableDownloadList(configXX.downloads));
	return configXX;
}
store.sub(SETTINGS, async () => {
	const settings = store.get(SETTINGS);
	if (isInitialized) {
		config = { ...config, ...settings.global };
		configXX = { ...configXX, settings: { ...configXX.settings, ...settings.game } };
	}
	if (settings.global.game != store.get(GAME)) store.set(GAME, settings.global.game);
	// const compare = {
	// 	src: [settings.global.game, settings.global.lang],
	// 	to: [GAME, LANG],
	// 	names: ["game", "lang"],
	// };
	// for (let i = 0; i < compare.src.length; i++) {
	// 	if (compare.src[i] !== store.get(compare.to[i])) {
	// 		if (compare.names[i] === "lang" && compare.src[i])
	// 			store.set(TEXT_DATA, TEXT[compare.src[i] as "en"] || TEXT["en"]);
	// 		// else if (compare.names[i] === "game" && compare.src[i]) await initGame(compare.src[i]);
	// 		store.set(compare.to[i] as any, compare.src[i]);
	// 	}
	// }
});
store.sub(SAVED_LANG, () => {
	const lang = store.get(SAVED_LANG);
	store.set(TEXT_DATA, TEXT[store.get(SAVED_LANG) as "en"] || TEXT["en"]);
	if (lang) {
		store.set(LANG, lang);
	}
});
function generationForCurrentBootstrap() {
	return store.get(BOOTSTRAP_STATE).generation;
}

export async function setCategories(
	game: Games = prevGame as Games,
	status = true,
	refreshRemote = true,
	generation = generationForCurrentBootstrap()
) {
	info("[IMM] Setting categories...");

	// await new Promise((resolve) => setTimeout(resolve, 10000));
	if (!game) return;
	const provider = getGameBananaProvider(game);
	let nextCategories: Category[] = [];
	let nextTypes = provider.fallbackTypes;
	if (refreshRemote) {
		try {
			if (status) store.set(MAIN_FUNC_STATUS, "Fetching game categories from Gamebanana");
			const result = await provider.categories();
			nextCategories = result.categories;
			nextTypes = result.types;
			if (!nextCategories.length) throw new Error("No categories found, please verify the directories again");
		} catch (e) {
			if (status) store.set(MAIN_FUNC_STATUS, "Unable to reach Gamebanana");
			info("[IMM] Failed to fetch categories from API, using local config if available.", e);
		}
	}
	if (!nextCategories.length) {
		nextCategories =
			configXX.categories && configXX.categories.length > 0 ? configXX.categories : provider.fallbackCategories;
		if (game === "NTE" && configXX.categories?.length) {
			nextTypes = configXX.categories.map((category) => ({ ...category }));
		}
	}
	if (generation !== latestBootstrapGeneration || (refreshRemote && game !== store.get(GAME))) return;
	prevGame = game;
	if (!nextCategories.length) return;
	info("[IMM] Finalized categories:", nextCategories);
	const catObj: { [key: string]: Category } = {};
	nextCategories.forEach((cat) => {
		catObj[cat._sName] = cat;
	});
	const customCats = (configXX.settings.customCategories || {}) as Record<string, Partial<Category>>;
	for (const key of Object.keys(customCats)) {
		catObj[key] = { ...(catObj[key] || ({} as Category)), _sName: key, ...customCats[key] };
	}
	categories = Object.values(catObj).map((cat) => ({ ...cat, _sIconUrl: cat._sIconUrl || "/who.jpg" }));
	store.set(CATEGORIES, categories);
	store.set(TYPES, nextTypes);
}
function removeHelpers() {
	stopWindowMonitoring();
	unregisterAll();
	resetPageCounts();
}
export async function launchGame() {
	if (config.game === "NTE") {
		const suffix = "\\Client\\WindowsNoEditor\\HT\\Content\\Paks\\~mods";
		const configuredTarget = store.get(TARGET) || configXX.targetDir;
		const normalizedTarget = String(configuredTarget || "")
			.replaceAll("/", "\\")
			.replace(/\\+$/g, "");
		const gameRoot = normalizedTarget.toLowerCase().endsWith(suffix.toLowerCase())
			? normalizedTarget.slice(0, -suffix.length)
			: "";
		if (!gameRoot) {
			addToast({ type: "error", message: store.get(TEXT_DATA)._Checklist.NTEGameRootNotConfigured });
			return;
		}
		try {
			await invoke("launch_nte_game", {
				gameRoot,
				region: store.get(NTE_REGION) || configXX.nteRegion || null,
			});
			addToast({ type: "info", message: "Launching Game" });
		} catch (launchError) {
			error("[IMM] Unable to launch NTE:", launchError);
			addToast({ type: "error", message: store.get(TEXT_DATA)._Toasts.ErrOcc });
		}
		return;
	}
	await syncIniStateOnce("launch-game");
	if (config.XXMI)
		isGameProcessRunning(config.game).then((running) => {
			if (!running) {
				executeXXMI();
				addToast({
					type: "info",
					message: "Launching Game",
				});
			}
		});
}
async function initHelpers() {
	info("[IMM] Initializing helpers...");
	if (configXX.settings.launch == 1 && GAMES.includes(config.game as RuntimeGame)) {
		void launchGame().catch((launchError) => {
			error("[IMM] Automatic game launch failed:", launchError);
			addToast({ type: "error", message: store.get(TEXT_DATA)._Toasts.ErrOcc });
		});
	}
	if (config.game !== "NTE") {
		setHotreload(configXX.settings.hotReload as 0 | 1 | 2, config.game);
	}

	registerGlobalHotkeys();
}
export function maintainBackups() {
	info("[IMM] Configuration integrity and recovery are managed by AppStateRepository.");
	store.set(MAIN_FUNC_STATUS, "Validating managed application state");
}
let cwd = "";
let runtimeDirPromise: Promise<string> | null = null;
export function getCwd() {
	return cwd;
}
export function isAppInitialized() {
	return isInitialized;
}
async function readRuntimeDataDir() {
	if (!runtimeDirPromise) {
		runtimeDirPromise = invoke<string>("get_runtime_data_dir").catch(async () =>
			join(await path.localDataDir(), "Integrated Mod Manager (IMM) Data")
		);
	}
	return runtimeDirPromise;
}
function parseUpdateBody(update: Update | null, lang: string) {
	if (!update?.body) return {};
	try {
		const parsed = readJsonText<unknown>(update.body);
		if (!isRecord(parsed)) return {};
		return normalizeUpdateBodyEntry(parsed[lang] ?? parsed);
	} catch {
		return {};
	}
}
export async function refreshAppUpdateCheck(openUpdater = false) {
	store.set(IMM_UPDATE, {
		version: VERSION,
		date: "",
		body: "{}",
		status: "checking",
		raw: null,
		error: "",
	});
	try {
		const update = await check({ timeout: 15000 });
		if (!update) {
			store.set(IMM_UPDATE, {
				version: VERSION,
				date: "",
				body: "{}",
				status: "up_to_date",
				raw: null,
				error: "",
			});
			if (openUpdater) store.set(UPDATER_OPEN, true);
			return null;
		}

		const lang = config.lang || "en";
		const parsedBody = parseUpdateBody(update, lang);
		const notice = parsedBody.notice || {};
		const lastConfig = config.notice || 0;
		let noticeOpen = false;
		if ((notice.id ?? 0) > 0 && compareVersions(notice.ver || "0.0.0", VERSION) > 0) {
			store.set(NOTICE, (prev) => ({ ...prev, ...notice }));
			if ((notice.id ?? 0) !== lastConfig || notice.ignoreable == 0) {
				noticeOpen = true;
				store.set(NOTICE_OPEN, true);
			}
		}

		store.set(IMM_UPDATE, {
			version: update.version,
			date: update.date || "",
			body: JSON.stringify(parsedBody) || "{}",
			status: "available",
			raw: update,
			error: "",
		});
		if (openUpdater || (!noticeOpen && compareVersions(update.version || "0.0.0", config.ignore || VERSION) > 0)) {
			store.set(UPDATER_OPEN, true);
		}
		store.set(SETTINGS, (prev) => ({
			...prev,
			global: sanitizeGlobalSettings({
				...prev.global,
				notice: notice.id || prev.global.notice || 0,
			}),
		}));
		return update;
	} catch (error: unknown) {
		store.set(IMM_UPDATE, {
			version: VERSION,
			date: "",
			body: "{}",
			status: "error",
			raw: null,
			error: getErrorMessage(error),
		});
		if (openUpdater) store.set(UPDATER_OPEN, true);
		return null;
	}
}
async function runRuntimeBootstrap(useGame: Games, generation: number): Promise<RuntimeBootstrapState> {
	try {
		if (generation !== latestBootstrapGeneration) return store.get(BOOTSTRAP_STATE);
		publishBootstrapState(generation, "preparing", useGame, "initializing-app");
		store.set(MAIN_FUNC_STATUS, "Initializing App");
		isInitialized = false;
		info("[IMM] Initializing application...");
		invoke("get_username");
		resetAtoms();
		removeHelpers();
		cwd = await readRuntimeDataDir();
		info("[IMM] Runtime data directory:", cwd);
		if (!(await safeExists("config.json"))) {
			store.set(MAIN_FUNC_STATUS, "Creating default config.json");
			info("[IMM] Creating default config.json...");
			await safeWriteTextFile("config.json", JSON.stringify(defConfig, null, 2));
		}
		await maintainBackups();
		info("[IMM] Reading runtime config.json...");
		const rawConfigText = await safeReadTextFile("config.json");
		info("[IMM] Runtime config.json length:", rawConfigText.length);
		const rawConfig = readJsonText<Record<string, unknown>>(rawConfigText);
		config = sanitizeGlobalSettings(safeLoadJson(structuredClone(defConfig), rawConfig));
		if (compareVersions(config.version || "0.0.0", "2.2.0") < 0) {
			config.chkModUpdates = true;
			config.bgType = 1;
		}
		config = sanitizeGlobalSettings(config);
		info("[IMM] Loaded config:", config);
		store.set(MAIN_FUNC_STATUS, "Config loaded");
		publishBootstrapState(generation, "preparing", useGame || config.game, "config-loaded");
		const savedLang = store.get(SAVED_LANG);
		if (!savedLang && config.lang) {
			store.set(SAVED_LANG, config.lang);
		}
		config.lang = store.get(SAVED_LANG) || config.lang;
		if (!config.XXMI && !config.game && !config.lang) {
			store.set(MAIN_FUNC_STATUS, "First time setup detected");
			info("[IMM] First time setup detected.");
			store.set(FIRST_LOAD, true);
		} else {
			store.set(FIRST_LOAD, false);
		}
		if (config.XXMI == "" || !(await configuredXxmiIsReadable())) {
			config.XXMI = (await invoke<string | null>("discover_xxmi_launcher_dir")) || "";
		}
		paths.XX = config.XXMI;
		config.game = useGame || config.game;
		if (sessionStorage.getItem("imm-deep-link-game")) {
			config.game = sessionStorage.getItem("imm-deep-link-game") as Games;
			config.game = GAMES.includes(config.game) ? config.game : "";
			sessionStorage.removeItem("imm-deep-link-game");
		}
		if (compareVersions(config.version || "0.0.0", "2.1.0") < 0) {
			config = await updateConfig();
		}
		info("[IMM] Saving config...");
		await safeWriteTextFile("config.json", JSON.stringify(config, null, 2));
		await readXXMIConfig();
		store.set(MAIN_FUNC_STATUS, "Initializing game");
		info("[IMM] Initializing game...");
		if (config.game) configXX = await initGame(config.game as RuntimeGame);
		publishBootstrapState(generation, "preparing", config.game, "game-prepared");
		info("[IMM] Setting window type...");
		if (config.winType > 1) setWindowType(config.winType);
		const bg = document.querySelector("body");
		if (bg)
			bg.style.backgroundColor = "color-mix(in oklab, var(--background) " + config.bgOpacity * 100 + "%, transparent)";

		store.set(SETTINGS, (prev) => ({
			global: sanitizeGlobalSettings({ ...prev.global, ...config }),
			game: { ...prev.game, ...configXX.settings },
		}));
		initHelpers();
		isInitialized = true;
		store.set(MAIN_FUNC_STATUS, "fin");
		void refreshAppUpdateCheck(false);

		if (generation !== latestBootstrapGeneration) return store.get(BOOTSTRAP_STATE);
		if (!config.game) {
			return publishBootstrapState(generation, "needsConfiguration", "", "select-game");
		}
		if (!configXX.sourceDir || !configXX.targetDir) {
			return publishBootstrapState(generation, "needsConfiguration", config.game, "configure-paths");
		}

		publishBootstrapState(generation, "prepared", config.game, "runtime-prepared");
		if (config.game === "NTE") {
			try {
				const validation = await invoke<NteModsRootValidation>("validate_nte_mods_root", {
					modsRoot: configXX.targetDir,
					region: configXX.nteRegion === "auto" ? null : configXX.nteRegion || null,
				});
				if (validation.valid) return completeRuntimeBootstrap("NTE");
				return publishBootstrapState(
					generation,
					"needsConfiguration",
					"NTE",
					"validate-nte-mods-root",
					validation.message || "Configured NTE Mods root is no longer valid"
				);
			} catch (validationError) {
				return publishBootstrapState(
					generation,
					"needsConfiguration",
					"NTE",
					"validate-nte-mods-root",
					getErrorMessage(validationError)
				);
			}
		}
		return completeRuntimeBootstrap(config.game);
	} catch (error) {
		const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
		info("[IMM] main() failed:", message);
		if (generation === latestBootstrapGeneration) {
			store.set(MAIN_FUNC_STATUS, "Startup failed");
			store.set(ERR, message);
		}
		return publishBootstrapState(generation, "failed", useGame || store.get(GAME), "startup-failed", message);
	}
}

export function main(useGame = "" as Games): Promise<RuntimeBootstrapState> {
	const generation = ++latestBootstrapGeneration;
	publishBootstrapState(generation, "preparing", useGame, "queued");
	const operation = bootstrapQueue.then(() => runRuntimeBootstrap(useGame, generation));
	bootstrapQueue = operation.then(
		() => undefined,
		() => undefined
	);
	return operation;
}
