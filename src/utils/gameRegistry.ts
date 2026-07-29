export const GAME_REGISTRY = {
	WW: {
		key: "WW",
		serializedId: 0,
		displayName: "WuWa",
		displayNameZh: "鸣潮",
		gameBananaId: 20357,
		contentTypes: ["Skins", "UI", "Other"],
		adapterId: "gamebananaww",
	},
	ZZ: {
		key: "ZZ",
		serializedId: 1,
		displayName: "Z·Z·Z",
		displayNameZh: "绝区零",
		gameBananaId: 19567,
		contentTypes: ["Skins", "UI", "Other"],
		adapterId: "gamebananazz",
	},
	GI: {
		key: "GI",
		serializedId: 2,
		displayName: "Genshin",
		displayNameZh: "原神",
		gameBananaId: 8552,
		contentTypes: ["Skins", "UI", "Other"],
		adapterId: "gamebananagi",
	},
	SR: {
		key: "SR",
		serializedId: 3,
		displayName: "Star Rail",
		displayNameZh: "崩坏：星穹铁道",
		gameBananaId: 18366,
		contentTypes: ["Skins", "UI", "Other"],
		adapterId: "gamebananasr",
	},
	EF: {
		key: "EF",
		serializedId: 4,
		displayName: "Endfield",
		displayNameZh: "明日方舟：终末地",
		gameBananaId: 21842,
		contentTypes: ["Skins", "UI", "Other"],
		adapterId: "gamebananaef",
	},
	NTE: {
		key: "NTE",
		serializedId: 5,
		displayName: "Neverness to Everness",
		displayNameZh: "异环",
		gameBananaId: 23012,
		contentTypes: ["Skins", "UI", "Other"],
		adapterId: "gamebananante",
	},
} as const;

export type RegisteredGame = keyof typeof GAME_REGISTRY;
export type GameContentType = (typeof GAME_REGISTRY)[RegisteredGame]["contentTypes"][number];
export type GameRegistryEntry = (typeof GAME_REGISTRY)[RegisteredGame];

export function getGameRegistryEntry(game: RegisteredGame): GameRegistryEntry {
	return GAME_REGISTRY[game];
}

export function getGameBySerializedId(serializedId: number): GameRegistryEntry | undefined {
	return Object.values(GAME_REGISTRY).find((entry) => entry.serializedId === serializedId);
}

export function getGameByGameBananaId(gameBananaId: number): GameRegistryEntry | undefined {
	return Object.values(GAME_REGISTRY).find((entry) => entry.gameBananaId === gameBananaId);
}
