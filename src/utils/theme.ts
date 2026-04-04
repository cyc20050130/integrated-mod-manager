import { Games } from "./types";
import { LANG, store } from "./vars";

type GameTheme = "wuwa" | "zzz" | "gi" | "sr" | "ef";
export type Language = "en" | "cn" | "jp" | "kr" | "ru";
function gameToTheme(game: Games): GameTheme {
	return ({ WW: "wuwa", ZZ: "zzz", GI: "gi", "": "", SR: "sr", EF: "ef" }[game] || "wuwa") as GameTheme;
}
function themeToGame(theme: GameTheme): Games {
	return ({ wuwa: "WW", zzz: "ZZ", gi: "GI", sr: "SR", ef: "EF" }[theme] || "WW") as Games;
}

/**
 * Switch between WuWa and ZZZ themes
 * @param theme - The theme to switch to ('wuwa' or 'zzz')
 */
// let interval = null as any;
export function switchGameTheme(theme: Games): void {
	const root = document.documentElement;

	// Remove any existing theme data attribute
	root.removeAttribute("data-theme");

	// Set the new theme
	root.setAttribute("data-theme", gameToTheme(theme));

	// Optional: Store theme preference in localStorage
	localStorage.setItem("game-theme", gameToTheme(theme));

	//info(`Switched to ${theme.toUpperCase()} theme`);
}

/**
 * Switch language and update data attribute
 * @param language - The language to switch to ('en' | 'cn' | 'jp' | 'kr' | 'ru')
 */
export function switchLanguage(): void {
	const language = getCurrentLanguage();
	console.log(`[IMM] Switching language to ${language.toUpperCase()}...`);
	const root = document.documentElement;
	// Set the language data attribute
	root.setAttribute("data-lang", language);
	console.log(`Switched to ${language.toUpperCase()} language`);
}

store.sub(LANG, () => {
	switchLanguage();
});

/**
 * Get the current active theme
 * @returns The current theme ('wuwa' or 'zzz')
 */
export function getCurrentTheme(): GameTheme {
	const root = document.documentElement;
	const currentTheme = root.getAttribute("data-theme") as GameTheme;

	// Default to 'wuwa' if no theme is set
	return currentTheme || "wuwa";
}

/**
 * Get the current active language
 * @returns The current language ('en' | 'cn' | 'jp' | 'kr' | 'ru')
 */
export function getCurrentLanguage(): Language {
	try {
		const savedLanguage = JSON.parse(localStorage.getItem("imm-lang") || "null") as Language;
		return savedLanguage || "en";
	} catch {
		return "en";
	}
}

/**
 * Initialize theme from localStorage or default to WuWa
 */
export function initializeThemes(): void {
	const savedTheme = localStorage.getItem("game-theme") as GameTheme;
	const themeToUse = savedTheme || "wuwa";
	switchGameTheme(themeToGame(themeToUse));
	switchLanguage();
}



/**
 * Toggle between WuWa and ZZZ themes
 */
export function toggleGameTheme(): void {
	const currentTheme = getCurrentTheme();
	const newTheme: GameTheme = currentTheme === "wuwa" ? "zzz" : "wuwa";

	switchGameTheme(themeToGame(newTheme));
}
