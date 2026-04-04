import { invoke } from "@tauri-apps/api/core";
import { GAME_ID_MAP } from "./consts";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export function join(...parts: string[]) {
	let result = parts.join("\\").replace("/", "\\").replaceAll("\\\\", "\\");
	result = result.endsWith("\\") ? result.slice(0, -1) : result;
	result = result.startsWith("\\") ? result.slice(1) : result;
	return result;
}
export function updateIni(tgt: string, foreground = 0) {
	tgt=tgt.split("\\").slice(0,-1).join("\\");
	const target = join(tgt, "d3dx.ini");
	exists(target).then((res) => {
		if (!res) return;
		readTextFile(target).then((data) => {
			let modified = false;
			const lines = data.split("\n").map((line) => {
				const trimmed = line.trim();
				if (trimmed.startsWith("check_foreground_window") && !trimmed.endsWith(foreground.toString())) {
					modified = true;
					return `check_foreground_window = ${foreground}`;
				}
				return line;
			});
			if (modified) {
				writeTextFile(target, lines.join("\n"));
			}
		});
	});
}
export async function setHotreload(enabled: 0 | 1 | 2, game: string, target: string): Promise<void> {
	try {
		if (enabled == 1) {
			updateIni(target, 0);
		} else {
			updateIni(target, 1);
		}
		await invoke("set_hotreload", { enabled: enabled ? true : false });
		if (enabled) {
            //info("Setting hotreload for game:", { targetGame: enabled == 1 || !game ? 0 : GAME_ID_MAP[game] + 1 });
			await invoke("set_window_target", { targetGame: enabled == 1 || !game ? 0 : GAME_ID_MAP[game] + 1 });
			await startWindowMonitoring();
		} else await stopWindowMonitoring();
	} catch (error) {
		// logger.error("Failed to set hotreload:", error);
		throw error;
	}
}
export async function setChange(trigger = true): Promise<void> {
	try {
		await invoke("set_change", { trigger });
	} catch (error) {
		// logger.error("Failed to set change trigger:", error);
		throw error;
	}
}
export async function startWindowMonitoring(): Promise<void> {
	try {
		await invoke("start_window_monitoring");
	} catch (error) {
		// logger.error("Failed to start window monitoring:", error);
		throw error;
	}
}
export async function stopWindowMonitoring(): Promise<void> {
	try {
		await invoke("stop_window_monitoring");
	} catch (error) {
		// logger.error("Failed to stop window monitoring:", error);
		throw error;
	}
}
