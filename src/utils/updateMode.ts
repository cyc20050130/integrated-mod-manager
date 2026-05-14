function normalizeWindowsPath(value: string) {
	return value.replaceAll("/", "\\").replace(/\\+$/g, "").toLowerCase();
}

export function isPortableInstallDir(currentExeDir: string, localAppDataDir: string) {
	if (!currentExeDir || !localAppDataDir) return false;
	const managedInstallDir = `${normalizeWindowsPath(localAppDataDir)}\\integrated mod manager (imm)`;
	return normalizeWindowsPath(currentExeDir) !== managedInstallDir;
}

export function getPortableUpdateUrl(rawJson: Record<string, unknown> | null | undefined) {
	const platforms = rawJson && typeof rawJson === "object" ? (rawJson.platforms as Record<string, unknown> | undefined) : undefined;
	const windowsAsset = platforms?.["windows-x86_64"];
	if (!windowsAsset || typeof windowsAsset !== "object") return null;
	const url = (windowsAsset as { url?: unknown }).url;
	return typeof url === "string" && url.length > 0 ? url : null;
}
