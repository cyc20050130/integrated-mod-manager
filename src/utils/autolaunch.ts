import { invoke } from "@tauri-apps/api/core";
import { GAME, store } from "./vars";
import { GAME_ID_MAP } from "./consts";

export async function executeWithArgs(exePath: string, args: string[]): Promise<string> {
	return await invoke<string>("execute_with_args", {
		exePath: exePath,
		args: args,
	});
}
export async function executeXXMI(exePath: string, useNoGui: boolean = true, useXxmi: boolean = true): Promise<string> {
	const args: string[] = [];

	if (useNoGui) {
		args.push("--nogui");
	}

	if (useXxmi) {
		args.push("--xxmi", store.get(GAME) + "MI");
	}

	return executeWithArgs(exePath, args);
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
