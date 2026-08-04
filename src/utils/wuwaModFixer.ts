import { addToast } from "@/_Toaster/ToastProvider";
import { invoke } from "@tauri-apps/api/core";
import { saveConfigs } from "./filesys";
import { WuwaModFixerState } from "./types";
import { SETTINGS, store } from "./vars";

const FIXER_LABEL = "Wuwa Mod Fixer";
const FIXER_RELEASES_URL = "https://github.com/Moonholder/Wuwa_Mod_Fixer";
const BUNDLED_NOTES = "Bundled with IMM. No separate download is required.";

type BundledToolInfo = {
	version: string;
	exePath: string;
	sourcePath: string;
};

export type WuwaModFixerReleaseInfo = {
	version: string;
	tag: string;
	url: string;
	publishedAt: string;
	notes: string;
};

export type WuwaModFixerCheckResult = {
	installed: WuwaModFixerState;
	latest: WuwaModFixerReleaseInfo;
	updateAvailable: boolean;
};

function getStoredState(): WuwaModFixerState {
	return store.get(SETTINGS).global.wuwaModFixer;
}

function normalizeVersionTag(version = "") {
	return String(version || "")
		.trim()
		.replace(/^v/i, "");
}

function normalizeToolState(input?: Partial<WuwaModFixerState>): WuwaModFixerState {
	const current = getStoredState();
	return {
		version: typeof input?.version === "string" ? input.version : current.version || "",
		exePath: typeof input?.exePath === "string" ? input.exePath : current.exePath || "",
		checkedAt: Number.isFinite(input?.checkedAt) ? Number(input?.checkedAt) : current.checkedAt || 0,
		releaseUrl: typeof input?.releaseUrl === "string" ? input.releaseUrl : current.releaseUrl || "",
	};
}

async function persistToolState(input?: Partial<WuwaModFixerState>) {
	const nextState = normalizeToolState(input);
	store.set(SETTINGS, (prev) => ({
		...prev,
		global: {
			...prev.global,
			wuwaModFixer: nextState,
		},
	}));
	await saveConfigs();
	return nextState;
}

async function ensureBundledTool(): Promise<BundledToolInfo> {
	const bundled = await invoke<BundledToolInfo>("ensure_bundled_wuwa_mod_fixer");
	const nextState = await persistToolState({
		version: normalizeVersionTag(bundled.version),
		exePath: bundled.exePath,
		checkedAt: Date.now(),
		releaseUrl: FIXER_RELEASES_URL,
	});
	return {
		version: nextState.version,
		exePath: nextState.exePath,
		sourcePath: bundled.sourcePath,
	};
}

function toBundledReleaseInfo(version: string): WuwaModFixerReleaseInfo {
	return {
		version,
		tag: version ? `v${version}` : "",
		url: FIXER_RELEASES_URL,
		publishedAt: "",
		notes: BUNDLED_NOTES,
	};
}

export async function checkWuwaModFixerUpdate() {
	const ensured = await ensureBundledTool();
	const installed = getStoredState();
	return {
		installed,
		latest: toBundledReleaseInfo(ensured.version || installed.version),
		updateAvailable: false,
	} satisfies WuwaModFixerCheckResult;
}

export async function installOrUpdateWuwaModFixer() {
	const ensured = await ensureBundledTool();
	return persistToolState({
		version: ensured.version,
		exePath: ensured.exePath,
		checkedAt: Date.now(),
		releaseUrl: FIXER_RELEASES_URL,
	});
}

export async function launchWuwaModFixer() {
	return invoke<string>("launch_bundled_wuwa_mod_fixer");
}

export async function openWuwaModFixerFolder() {
	return invoke<void>("open_wuwa_mod_fixer_folder");
}

type WuwaModFixerText = {
	_Main?: { _components?: { _WuwaModFixer?: { Warning?: string; Missing?: string; LaunchFailed?: string } } };
};

export function getWuwaModFixerWarning(textData: WuwaModFixerText) {
	return (
		textData?._Main?._components?._WuwaModFixer?.Warning ||
		"If you already used a different fixer version on the same mod, restore that mod from backup before repairing again."
	);
}

export function getWuwaModFixerMissingMessage(textData: WuwaModFixerText) {
	return textData?._Main?._components?._WuwaModFixer?.Missing || `${FIXER_LABEL} is not ready yet.`;
}

export function showWuwaModFixerLaunchError(error: unknown, textData: WuwaModFixerText) {
	const message = error instanceof Error ? error.message : String(error || "Unknown error");
	addToast({
		type: "error",
		message: textData?._Main?._components?._WuwaModFixer?.LaunchFailed || message,
	});
}

export { FIXER_LABEL, FIXER_RELEASES_URL };
