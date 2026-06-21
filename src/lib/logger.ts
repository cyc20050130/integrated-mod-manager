import { error as traceError, info as traceInfo, warn as traceWarn } from "@fltsci/tauri-plugin-tracing";

const stringify = (...args: unknown[]): string =>
	args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");

const runtimeConsole = globalThis.console;
const isTauriRuntime =
	typeof globalThis !== "undefined" &&
	typeof globalThis.window !== "undefined" &&
	"__TAURI_INTERNALS__" in globalThis.window;

function emitTrace(kind: "info" | "warn" | "error", message: string) {
	if (!isTauriRuntime) return;
	try {
		if (kind === "info") traceInfo(message);
		else if (kind === "warn") traceWarn(message);
		else traceError(message);
	} catch {
		// Browser-only runs do not have the tracing bridge.
	}
}

export const info = (...args: unknown[]): void => {
	runtimeConsole.log(...args);
	emitTrace("info", stringify(...args));
};

export const warn = (...args: unknown[]): void => {
	runtimeConsole.warn(...args);
	emitTrace("warn", stringify(...args));
};

export const error = (...args: unknown[]): void => {
	runtimeConsole.error(...args);
	emitTrace("error", stringify(...args));
};
