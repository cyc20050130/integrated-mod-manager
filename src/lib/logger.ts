import { error as traceError, info as traceInfo, warn as traceWarn } from "@fltsci/tauri-plugin-tracing";

const stringify = (...args: unknown[]): string =>  args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
const runtimeConsole = globalThis.console;


export const info = (...args: unknown[]): void => {
	runtimeConsole.log(...args);
	traceInfo(stringify(...args));
};

export const warn = (...args: unknown[]): void => {
	runtimeConsole.warn(...args);
	traceWarn(stringify(...args));
};

export const error = (...args: unknown[]): void => {
	runtimeConsole.error(...args);
	traceError(stringify(...args));
};
