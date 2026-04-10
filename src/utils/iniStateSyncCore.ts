import type { ModDataObj } from "./types.js";

export interface IniStateTrackedMod {
	path: string;
	namespace?: string;
}

export interface IniStateSyncResult {
	nextData: ModDataObj;
	changedMods: string[];
}

type TrackedPathPrefix = {
	modPath: string;
	prefix: string;
};

type TrackedNamespacePrefix = {
	modPath: string;
	prefix: string;
};

function normalizeSlashes(value: string) {
	return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function normalizeIniKey(value: string) {
	return normalizeSlashes(value).replaceAll(" ", "").trim();
}

function parseIniAssignments(rawIni: string) {
	return rawIni
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(";") && line.includes("="))
		.map((line) => {
			const eqIndex = line.indexOf("=");
			return {
				key: normalizeIniKey(line.slice(0, eqIndex)),
				value: line.slice(eqIndex + 1).trim(),
			};
		});
}

function sortByPrefixLength<T extends { prefix: string }>(items: T[]) {
	return [...items].sort((left, right) => right.prefix.length - left.prefix.length);
}

function getPathPrefixes(trackedMods: IniStateTrackedMod[], managedTarget: string): TrackedPathPrefix[] {
	return sortByPrefixLength(
		trackedMods.map((mod) => ({
			modPath: mod.path,
			prefix: normalizeIniKey(`$\\mods\\${managedTarget}\\${mod.path}\\`),
		}))
	);
}

function getNamespacePrefixes(trackedMods: IniStateTrackedMod[]): TrackedNamespacePrefix[] {
	return sortByPrefixLength(
		trackedMods
			.filter((mod) => mod.namespace)
			.map((mod) => ({
				modPath: mod.path,
				prefix: normalizeIniKey(`$\\${mod.namespace}\\`),
			}))
	);
}

function cloneData(data: ModDataObj) {
	return structuredClone(data || {});
}

function ensureVarNode(nextData: ModDataObj, modPath: string, fileKey: string, variable: string) {
	nextData[modPath] = nextData[modPath] || {};
	nextData[modPath].vars = nextData[modPath].vars || {};
	nextData[modPath].vars[fileKey] = nextData[modPath].vars[fileKey] || {};
	nextData[modPath].vars[fileKey][variable] = nextData[modPath].vars[fileKey][variable] || {};
	return nextData[modPath].vars[fileKey][variable];
}

export function syncIniStateFromText(
	rawIni: string,
	data: ModDataObj,
	trackedMods: IniStateTrackedMod[],
	managedTarget: string
): IniStateSyncResult {
	if (!trackedMods.length) {
		return {
			nextData: data || {},
			changedMods: [],
		};
	}

	const assignments = parseIniAssignments(rawIni);
	const pathPrefixes = getPathPrefixes(trackedMods, managedTarget);
	const namespacePrefixes = getNamespacePrefixes(trackedMods);
	const nextData = cloneData(data || {});
	const changedMods = new Set<string>();

	for (const { key, value } of assignments) {
		if (!value) continue;

		const pathMatch = pathPrefixes.find((candidate) => key.startsWith(candidate.prefix));
		if (pathMatch) {
			const remainder = key.slice(pathMatch.prefix.length);
			const lastSlash = remainder.lastIndexOf("\\");
			if (lastSlash <= 0 || lastSlash >= remainder.length - 1) continue;
			const fileKey = remainder.slice(0, lastSlash);
			const variable = remainder.slice(lastSlash + 1);
			if (!fileKey || !variable) continue;
			const node = ensureVarNode(nextData, pathMatch.modPath, fileKey, variable);
			if (node.state !== value) {
				node.state = value;
				changedMods.add(pathMatch.modPath);
			}
			continue;
		}

		const namespaceMatch = namespacePrefixes.find((candidate) => key.startsWith(candidate.prefix));
		if (!namespaceMatch) continue;
		const variable = key.slice(namespaceMatch.prefix.length).replace(/^\\+|\\+$/g, "");
		if (!variable) continue;
		const node = ensureVarNode(nextData, namespaceMatch.modPath, "namespace", variable);
		if (node.state !== value) {
			node.state = value;
			changedMods.add(namespaceMatch.modPath);
		}
	}

	return {
		nextData,
		changedMods: Array.from(changedMods),
	};
}
