import { error as pluginError, info as pluginInfo, warn as pluginWarn } from "@tauri-apps/plugin-log";

const stringify = (...args: unknown[]): string =>
	args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");

const runtimeConsole = globalThis.console;
const isTauriRuntime =
	typeof globalThis !== "undefined" &&
	typeof globalThis.window !== "undefined" &&
	"__TAURI_INTERNALS__" in globalThis.window;

function emitLog(kind: "info" | "warn" | "error", message: string) {
	if (!isTauriRuntime) return;
	const pending = kind === "info" ? pluginInfo(message) : kind === "warn" ? pluginWarn(message) : pluginError(message);
	void pending.catch(() => {
		// Browser-only tests and shutdown races can make the native bridge unavailable.
	});
}

export const info = (...args: unknown[]): void => {
	runtimeConsole.log(...args);
	emitLog("info", stringify(...args));
};

export const warn = (...args: unknown[]): void => {
	runtimeConsole.warn(...args);
	emitLog("warn", stringify(...args));
};

export const error = (...args: unknown[]): void => {
	runtimeConsole.error(...args);
	emitLog("error", stringify(...args));
};
