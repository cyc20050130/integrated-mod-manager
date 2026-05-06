import {
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
import { exists, mkdir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import defConfig from "../default.json";
import defConfigXX from "../defaultXX.json";
import { apiClient } from "./api";
import { GAMES, VERSION } from "./consts";
import { switchGameTheme } from "./theme";
import { executeXXMI, isGameProcessRunning } from "./autolaunch";
// import { updateIni } from "./iniUpdater";
import { join, setHotreload, stopWindowMonitoring } from "./hotreload";
import { registerGlobalHotkeys } from "./hotkeyUtils";
import TEXT from "@/textData.json";
import { unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { compareVersions, safeLoadJson, sanitizeGlobalSettings, setImageServer } from "./utils";
import { addToast } from "@/_Toaster/ToastProvider";
import { Category, DownloadList, GameSettings, Games, GlobalSettings, ModDataObj, Preset, Settings } from "./types";
import { toResumableDownloadList, withNormalizedDownloadSettings } from "./downloads";
import { resetPageCounts } from "@/_Main/MainOnline";
import { info } from "@/lib/logger";
import { syncIniStateOnce } from "./iniStateSync";
// import { v2_0_4_migration } from "./filesys";

type RuntimeGlobalConfig = GlobalSettings & { version?: string; updatedAt?: string; notice?: number };
type RuntimeGameConfig = {
	version: string;
	game: Games;
	custom: 0 | 1;
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
	try {
		return await exists(pathLike);
	} catch (error) {
		info(`[IMM] exists() check failed for ${pathLike}:`, error);
		return false;
	}
}

async function safeWriteTextFile(pathLike: string, contents: string) {
	try {
		await writeTextFile(pathLike, contents);
		return true;
	} catch (error) {
		info(`[IMM] writeTextFile() failed for ${pathLike}:`, error);
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
};
let isInPrePostLaunch = {
	WW: false,
	ZZ: false,
	GI: false,
	SR: false,
	EF: false,
	"": false,
};

export function getPaths() {
	return paths;
}
let config: RuntimeGlobalConfig = sanitizeGlobalSettings({ ...defConfig }) as RuntimeGlobalConfig;
let configXX: RuntimeGameConfig = { ...defConfigXX } as RuntimeGameConfig;
let dataDir = "";
let appData = "";
let prevGame = "";
let categories: Category[] = [];
let isInitialized = false;
async function getXXMIConfig(path = store.get(XXMI_DIR)): Promise<XXMIConfig | null> {
	try {
		return readJsonText<XXMIConfig>(await readTextFile(join(path, "XXMI Launcher Config.json")));
	} catch (e) {
		info("[IMM] Failed to read XXMI Launcher config:", e);
		return null;
	}
}
export async function setPrePostLaunch(game: Games, value: boolean) {
	const data = await getXXMIConfig();
	if (!data) return;
	const importer = data.Importers[game + "MI"];
	if (!importer) return;
	const cmd = `start imm://mode/${game.toLowerCase()}`;
	if (value) {
		if (!importer.Importer.run_pre_launch.includes(cmd))
			importer.Importer.run_pre_launch = [
				cmd,
				...importer.Importer.run_pre_launch.split(" && "),
			]
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
	await writeTextFile(join(store.get(XXMI_DIR), "XXMI Launcher Config.json"), JSON.stringify(data, null, 2));
}
export async function readXXMIConfig(path: string) {
	paths = {
		"": "",
		exe: "",
		WW: "",
		ZZ: "",
		GI: "",
		SR: "",
		XX: "",
		EF: "",
	};
	isInPrePostLaunch = {
		WW: false,
		ZZ: false,
		GI: false,
		SR: false,
		EF: false,
		"": false,
	};
	if (path && path != "") {
		const data = await getXXMIConfig(path);
		if (!data) return;
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
export const window = getCurrentWebviewWindow();
export function changeWindowTitle(title: string) {
	window.setTitle(title);
}
export async function setWindowType(type: number) {
	if (type == 0) {
		// if (await window.isMaximized())
		window.unmaximize();
		// window.setFullscreen(false);
		// window.setDecorations(true);
		// currentMonitor().then((x) => {
		// 	if (x?.size) window.setSize(new PhysicalSize(x.size.width * 0.8, x.size.height * 0.8));
		// });
	} else if (type == 1) {
		window.unmaximize();
		// window.setFullscreen(false);
		// window.setDecorations(false);
		// currentMonitor().then((x) => {
		// 	if (x?.size) window.setSize(new PhysicalSize(x.size.width * 0.8, x.size.height * 0.8));
		// });
	} else if (type == 2) {
		window.maximize();
		// window.setFullscreen(true);
	}
}
invoke<string>("get_image_server_url").then((url) => {
	setImageServer(url + "/preview");
});
export async function updateConfig(oconfig: LegacyConfig | null = null): Promise<RuntimeGlobalConfig> {
	if (!oconfig) oconfig = readJsonText<LegacyConfig>(await readTextFile("config.json"));
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
	await writeTextFile(
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
	const XXPath = paths[game];
	const dirs = {
		targetDir: "",
		sourceDir: "",
	};
	try {
		(await readTextFile(join(XXPath, "d3dx.ini"))).split("\n").forEach((line: string) => {
			const [key, value] = line.split("=").map((x: string) => x.trim());
			if (key == "include_recursive") {
				const isPath = value.slice(1, 3) == ":\\";
				dirs.targetDir = isPath ? value : join(XXPath, value);
				dirs.sourceDir = isPath ? value : join(XXPath, value);
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
	store.set(ONLINE_DATA, {});
	const savedConfig = (await safeExists(`config${game}.json`))
		? readJsonText<Partial<RuntimeGameConfig>>(await readTextFile(`config${game}.json`))
		: {};
	const mergedSettings = {
		...defConfigXX.settings,
		...(savedConfig.settings || {}),
		customCategories: {
			...defConfigXX.settings.customCategories,
			...(savedConfig.settings?.customCategories || {}),
		},
		download: {
			...defConfigXX.settings.download,
			...(savedConfig.settings?.download || {}),
		},
	} as GameSettings;
	configXX = {
		...defConfigXX,
		...savedConfig,
		game,
		settings: withNormalizedDownloadSettings(mergedSettings),
		data: (savedConfig.data || {}) as ModDataObj,
		downloads: toResumableDownloadList(savedConfig.downloads || defConfigXX.downloads),
		presets: savedConfig.presets || [],
		categories: savedConfig.categories || [],
		custom: (savedConfig.custom ?? defConfigXX.custom) as 0 | 1,
		sourceDir: savedConfig.sourceDir || defConfigXX.sourceDir,
		targetDir: savedConfig.targetDir || defConfigXX.targetDir,
		updatedAt: savedConfig.updatedAt || defConfigXX.updatedAt,
	};
	if (configXX.settings.launch === 2 && !isInPrePostLaunch[game]) configXX.settings.launch = 0;
	else if (isInPrePostLaunch[game]) configXX.settings.launch = 2;
	switchGameTheme(game);

	if (!configXX.custom) {
		configXX = { ...configXX, ...(await verifyGameDir(game)) };
	} else {
		dataDir = configXX.targetDir;
	}
	await writeTextFile(`config${game}.json`, JSON.stringify(configXX, null, 2));
	apiClient.setGame(game);
	await setCategories(game, status);
	invoke("set_window_icon", { game });
	// Validate source and target dirs
	if (configXX.sourceDir && !(await exists(join(configXX.sourceDir)))) configXX.sourceDir = "";
	if (configXX.targetDir && !(await exists(configXX.targetDir))) configXX.targetDir = "";
	if (status) store.set(MAIN_FUNC_STATUS, "Validating source and target directories");
	info("[IMM] Validating source and target directories...", configXX.sourceDir, configXX.targetDir);
	store.set(SOURCE, configXX.sourceDir || "");
	store.set(TARGET, configXX.targetDir || "");
	store.set(XXMI_MODE, (configXX.custom || 0) as 0 | 1);
	store.set(
		SETTINGS,
		(prev) => ({ global: { ...prev.global, game }, game: { ...prev.game, ...configXX.settings } }) as Settings
	);
	store.set(TYPES, apiClient.generic.types);
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
export async function setCategories(game = prevGame, status = true) {
	info("[IMM] Setting categories...");

	// await new Promise((resolve) => setTimeout(resolve, 10000));
	if (!game) return;
	prevGame = game;
	try {
		if (status) store.set(MAIN_FUNC_STATUS, "Fetching game categories from Gamebanana");
		categories = await apiClient.categories();
		//info("Fetched categories:", categories);
		if (!categories || categories.length == 0) throw "No categories found, please verify the directories again";
	} catch (e) {
		if (status) store.set(MAIN_FUNC_STATUS, "Unable to reach Gamebanana");
		info("[IMM] Failed to fetch categories from API, using local config if available.", e);
		categories =
			configXX.categories && configXX.categories.length > 0
				? configXX.categories
				: [...apiClient.categoryList, ...apiClient.generic.categories];
	}
	//info("Using categories:", categories,apiClient.categoryList,configXX.categories);
	if (!categories || categories.length == 0) return;
	info("[IMM] Finalized categories:", categories);
	const catObj: { [key: string]: Category } = {};
	categories.forEach((cat) => {
		catObj[cat._sName] = cat;
	});
	const customCats = (configXX.settings.customCategories || {}) as Record<string, Partial<Category>>;
	for (const key of Object.keys(customCats)) {
		catObj[key] = { ...(catObj[key] || ({} as Category)), _sName: key, ...customCats[key] };
	}
	categories = Object.values(catObj).map((cat) => ({ ...cat, _sIconUrl: cat._sIconUrl || "/who.jpg" }));
	store.set(CATEGORIES, categories);
}
function removeHelpers() {
	stopWindowMonitoring();
	unregisterAll();
	resetPageCounts();
}
export async function launchGame() {
	await syncIniStateOnce("launch-game");
	if (await exists(config.XXMI))
		isGameProcessRunning(config.game).then((running) => {
			if (!running) {
				executeXXMI(join(config.XXMI, "Resources\\Bin\\XXMI Launcher.exe"));
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
		launchGame();
	}
	setHotreload(configXX.settings.hotReload as 0 | 1 | 2, config.game, configXX.targetDir);

	registerGlobalHotkeys();
}
export async function checkWWMM() {
	info("[IMM] Checking for WWMM config...");
	const wwmmPath = await path.join(await path.localDataDir(), "Wuwa Mod Manager (WWMM)", "config.json");
	if (await safeExists(wwmmPath)) {
		//info('exists')
		return (await readTextFile(wwmmPath)) || null;
	}
	return null;
}
export async function maintainBackups() {
	info("[IMM] Maintaining backups...");
	store.set(MAIN_FUNC_STATUS, "Maintaining backups");
	const files = GAMES.map((g) => `config${g}.json`);
	files.push("config.json");
	mkdir("backups", { recursive: true });
	const backupPath = "backups\\AUTO_";
	for (const file of files) {
		if (await safeExists(file)) {
			try {
				const data = JSON.parse(await readTextFile(file));
				delete data.categories;
				if (await safeExists(backupPath + file + ".bak")) {
					try {
						const backupData = readJsonText<Record<string, unknown>>(await readTextFile(backupPath + file + ".bak"));
						if (
							backupData.updatedAt &&
							new Date().getTime() - new Date(String(backupData.updatedAt)).getTime() > 24 * 60 * 60 * 1000
						) {
							info(`[IMM] Creating backup for: ${file}...`);
							await remove(backupPath + file + ".bak.bak").catch(() => undefined);
							const currentBackupText = await readTextFile(backupPath + file + ".bak");
							await safeWriteTextFile(backupPath + file + ".bak.bak", currentBackupText);
							await safeWriteTextFile(backupPath + file + ".bak", JSON.stringify(data, null, 2));
						}
					} catch {
						info(`[IMM] Detected corrupted backup file: ${file}.bak, creating new backup...`);
						await safeWriteTextFile(backupPath + file + ".bak", JSON.stringify(data, null, 2));
					}
				} else {
					info(`[IMM] Creating initial backup for: ${file}...`);
					await safeWriteTextFile(backupPath + file + ".bak", JSON.stringify(data, null, 2));
				}
			} catch {
				info(`[IMM] Detected corrupted config file: ${file}, restoring from backup...`);
				store.set(MAIN_FUNC_STATUS, `Config file corrupted, restoring from backup`);
				if (await safeExists(backupPath + file + ".bak")) {
					try {
						const backupData = readJsonText<Record<string, unknown>>(await readTextFile(backupPath + file + ".bak"));
						await safeWriteTextFile(file, JSON.stringify(backupData, null, 2));
						info(`[IMM] Successfully restored backup for: ${file}`);
					} catch {
						info(`[IMM] Detected corrupted backup config file: ${file}.bak, restoring from secondary backup...`);
						if (await safeExists(backupPath + file + ".bak.bak")) {
							try {
								const backupData2 = readJsonText<Record<string, unknown>>(
									await readTextFile(backupPath + file + ".bak.bak")
								);
								await safeWriteTextFile(file, JSON.stringify(backupData2, null, 2));
								await safeWriteTextFile(backupPath + file + ".bak", JSON.stringify(backupData2, null, 2));
								info(`[IMM] Successfully restored secondary backup for: ${file}`);
							} catch (e) {
								info(`[IMM] Failed to restore secondary backup for: ${file}:`, e);
								info(`[IMM] Manual intervention required to fix config file: ${file}`);
								store.set(
									ERR,
									`Corrupted config file detected: ${file}, ${backupPath + file + ".bak"} & ${
										backupPath + file + ".bak.bak"
									}. Unable to proceed, please restore manually or press ESC x3 to reset IMM.`
								);
							}
						} else {
							store.set(
								ERR,
								`Corrupted config file detected: ${file} & ${
									backupPath + file + ".bak"
								}. Unable to proceed, please restore manually or press ESC x3 to reset IMM.`
							);
						}
					}
				} else {
					info(`[IMM] No backup found for corrupted config file: ${file}. Manual intervention required.`);
					store.set(
						ERR,
						`Corrupted config file detected: ${file}. Unable to proceed, please restore manually or press ESC x3 to reset IMM.`
					);
				}
			}
		}
	}
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
export async function main(useGame = "" as Games) {
	try {
		store.set(MAIN_FUNC_STATUS, "Initializing App");
		isInitialized = false;
		info("[IMM] Initializing application...");
		invoke("get_username");
		resetAtoms();
		removeHelpers();
		appData = await path.dataDir();
		cwd = await readRuntimeDataDir();
		info("[IMM] Runtime data directory:", cwd);
		const XXMI = `${appData}\\XXMI Launcher`;
		if (!(await safeExists("config.json"))) {
			store.set(MAIN_FUNC_STATUS, "Creating default config.json");
			info("[IMM] Creating default config.json...");
			await writeTextFile("config.json", JSON.stringify(defConfig, null, 2));
		}
		await maintainBackups();
		info("[IMM] Reading runtime config.json...");
		const rawConfigText = await readTextFile("config.json");
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
		const savedLang = store.get(SAVED_LANG);
		if (!savedLang && config.lang) {
			store.set(SAVED_LANG, config.lang);
		}
		config.lang = store.get(SAVED_LANG) || config.lang;
		if (!config.XXMI && !config.game && !config.lang) {
			store.set(MAIN_FUNC_STATUS, "First time setup detected, checking for WWMM");
			info("[IMM] First time setup detected, checking for WWMM...");
			store.set(FIRST_LOAD, true);
			const temp = await checkWWMM();
			if (temp) config = await updateConfig(JSON.parse(temp));
		} else {
			store.set(FIRST_LOAD, false);
		}
		apiClient.setClient(config.clientDate || "");
		if ((config.XXMI == "" || !(await safeExists(config.XXMI))) && (await safeExists(XXMI))) {
			config.XXMI = XXMI;
		}
		paths.XX = config.XXMI;
		config.game = useGame || config.game;
		if (sessionStorage.getItem("imm-deep-link-game")) {
			config.game = sessionStorage.getItem("imm-deep-link-game") as Games;
			config.game = GAMES.includes(config.game) ? config.game : "";
			sessionStorage.removeItem("imm-deep-link-game");
		}
		if (config.game) apiClient.setGame(config.game as RuntimeGame);
		if (compareVersions(config.version || "0.0.0", "2.1.0") < 0) {
			config = await updateConfig();
		}
		info("[IMM] Saving config...");
		await writeTextFile("config.json", JSON.stringify(config, null, 2));
		await readXXMIConfig(config.XXMI || "");
		store.set(MAIN_FUNC_STATUS, "Initializing game");
		info("[IMM] Initializing game...");
		if (config.game) configXX = await initGame(config.game as RuntimeGame);
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
	} catch (error) {
		const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
		info("[IMM] main() failed:", message);
		store.set(MAIN_FUNC_STATUS, "Startup failed");
		store.set(ERR, message);
	}
}
