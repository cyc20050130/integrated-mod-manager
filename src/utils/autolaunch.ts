import { invoke } from "@tauri-apps/api/core";
import { GAME, store } from "./vars";
import { GAME_ID_MAP } from "./consts";

export async function executeXXMI(): Promise<string> {
	return invoke<string>("launch_configured_xxmi", { game: store.get(GAME) });
}

export async function isGameProcessRunning(game = "WW"): Promise<boolean> {
	try {
		const isRunning = await invoke<boolean>("is_game_process_running", { gameId: GAME_ID_MAP[game] });
		//logger.log(`Game process running: ${isRunning}`);
		return isRunning;
	} catch {
		// logger.error("Failed to check if game process is running:", error);
		return false;
	}
}
