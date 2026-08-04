import { invoke } from "@tauri-apps/api/core";
import { GAME_ID_MAP } from "./consts";
import { warn } from "@/lib/logger";

export function join(...parts: string[]) {
	let result = parts.join("\\").replaceAll("/", "\\").replaceAll("\\\\", "\\");
	result = result.endsWith("\\") ? result.slice(0, -1) : result;
	result = result.startsWith("\\") ? result.slice(1) : result;
	return result;
}

export function updateIni(game: string, foreground = 0) {
	if (!game) return;
	invoke<void>("set_d3dx_foreground_mode", { game, foreground }).catch((error) => {
		warn("[IMM] Failed to update d3dx.ini hotreload setting:", error);
	});
}
export async function setHotreload(enabled: 0 | 1 | 2, game: string): Promise<void> {
	if (enabled == 1) {
		updateIni(game, 0);
	} else {
		updateIni(game, 1);
	}
	await invoke("set_hotreload", { enabled: enabled ? true : false });
	if (enabled) {
		await invoke("set_window_target", { targetGame: enabled == 1 || !game ? 0 : GAME_ID_MAP[game] + 1 });
		await startWindowMonitoring();
	} else await stopWindowMonitoring();
}
export async function setChange(trigger = true): Promise<void> {
	await invoke("set_change", { trigger });
}
export async function startWindowMonitoring(): Promise<void> {
	await invoke("start_window_monitoring");
}
export async function stopWindowMonitoring(): Promise<void> {
	await invoke("stop_window_monitoring");
}
