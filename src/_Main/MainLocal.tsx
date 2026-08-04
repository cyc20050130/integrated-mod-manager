import {
	CATEGORY,
	CONFLICTS,
	CONFLICTS_OPEN,
	FILTER,
	GAME,
	INIT_DONE,
	INSTALLED_ITEMS,
	MOD_LIST,
	openConflict,
	SEARCH,
	SELECTED,
	SETTINGS,
	SORT,
	SOURCE,
	TEXT_DATA,
} from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { motion } from "motion/react";
import CardLocal from "./components/CardLocal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isModBlacklisted, preventContextMenu } from "@/utils/utils";
import { openManagedFolder, toggleMod } from "@/utils/filesys";
import MiniSearch from "minisearch";
import { setChange } from "@/utils/hotreload";
import { managedSRC } from "@/utils/consts";
import { Mod } from "@/utils/types";
import { addToast } from "@/_Toaster/ToastProvider";
import { info } from "@/lib/logger";
import { useVirtualizer } from "@tanstack/react-virtual";
import { requestVisiblePreviewAssets } from "@/utils/imagePreview";

const CARD_COLUMN_WIDTH = 256;
const CARD_HEIGHT = 272;
const CARD_ROW_SIZE = 304;
const VIRTUAL_OVERSCAN_ROWS = 2;

let prevEnabled = "noData";
let timeout: ReturnType<typeof setTimeout> | null = null;

function MainLocal() {
	const initDone = useAtomValue(INIT_DONE);
	const textData = useAtomValue(TEXT_DATA);
	const [conflicts, setConflicts] = useAtom(CONFLICTS);
	const setConflictsOpen = useSetAtom(CONFLICTS_OPEN);
	const [modList, setModList] = useAtom(MOD_LIST);
	const installedItems = useAtomValue(INSTALLED_ITEMS);
	const updateObj = useMemo(() => {
		const obj: { [key: string]: boolean } = {};
		installedItems.forEach((item) => {
			obj[item.name] = item.modStatus == 2;
		});
		return obj;
	}, [installedItems]);
	const category = useAtomValue(CATEGORY);
	const filter = useAtomValue(FILTER);
	const search = useAtomValue(SEARCH);
	const game = useAtomValue(GAME);
	const source = useAtomValue(SOURCE);
	const [selected, setSelected] = useAtom(SELECTED);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const toggleOn = useAtomValue(SETTINGS).global.toggleClick;
	const sort = useAtomValue(SORT);
	const searchDB = useMemo(() => {
		if (modList.length === 0) return null;
		const index = new MiniSearch<Mod>({
			idField: "path",
			fields: ["name", "parent", "path"],
			storeFields: Object.keys(modList[0]),
			searchOptions: { prefix: true, fuzzy: 0.2 },
		});
		index.addAll(modList);
		return index;
	}, [modList]);

	useEffect(() => {
		if (!initDone) {
			prevEnabled = "noData";
		} else {
			const enabled = modList
				.filter((mod) => mod.enabled)
				.map((mod) => mod.path)
				.join(",");
			if (prevEnabled !== enabled) {
				if (timeout) clearTimeout(timeout);
				timeout = setTimeout(() => {
					setChange();
				}, 250);
			}
			prevEnabled = enabled;
		}

		const allHashes: { [key: string]: Set<string> } = {};
		const hashes: { [key: string]: string[] } = {};
		[...modList]
			.sort((a, b) => a.path.localeCompare(b.path))
			.forEach((mod) => {
				mod.hashes?.forEach((hash) => {
					if (mod.enabled) {
						if (!hashes[hash]) hashes[hash] = [];
						hashes[hash].push(mod.path);
					}
					if (!allHashes[hash]) allHashes[hash] = new Set();
					allHashes[hash].add(mod.parent);
				});
			});
		const validHashes = Object.entries(allHashes).filter(([_, parents]) => parents.size == 1);
		const collisions = Object.entries(hashes).filter(
			([hash, paths]) => paths.length > 1 && validHashes.some(([validHash]) => validHash === hash)
		);
		const collisionMap: Record<string, Set<string>> = {};
		collisions.forEach(([_, paths]) => {
			const key = paths[0];
			collisionMap[key] = collisionMap[key] || new Set();
			paths.slice(1).forEach((path) => collisionMap[key].add(path));
		});
		const modsInvolved: Record<string, number> = {};
		const newConflicts = Object.keys(collisionMap).map((key, index) => {
			const paths = [key, ...collisionMap[key]];
			paths.forEach((path) => {
				modsInvolved[path] = modsInvolved[path] || index;
			});
			return paths;
		});

		const conflictsChanged = JSON.stringify(conflicts.conflicts) !== JSON.stringify(newConflicts);
		if (collisions.length > 0 && conflictsChanged) {
			addToast({
				type: "error",
				message: textData._Toasts.CollisionsDetected,
				onClick: openConflict,
			});
			setConflicts({ conflicts: newConflicts, mods: modsInvolved });
		} else if (collisions.length == 0 && conflicts.conflicts.length > 0) {
			setConflicts({ conflicts: [], mods: {} });
			setConflictsOpen(false);
		}
	}, [conflicts.conflicts, initDone, modList, setConflicts, setConflictsOpen, textData._Toasts.CollisionsDetected]);

	const filteredList = useMemo(() => {
		let newList: Mod[] =
			searchDB && search
				? searchDB
						.search(search)
						.map((result) => modList.find((mod) => mod.path === result.id))
						.filter((mod): mod is Mod => Boolean(mod))
				: [...modList];

		Object.entries(filter).forEach(([key, value]) => {
			let modifier = (mod: Mod) => !!mod;
			switch (key) {
				case "src":
					modifier = (mod) => value == "any" || (value == "has" ? !!mod.source : !mod.source);
					break;
				case "st":
					modifier = (mod) => value == "all" || (value == "enabled" ? mod.enabled : !mod.enabled);
					break;
				case "tag": {
					const valObj = value as Record<string, string>;
					modifier = (mod) =>
						Object.entries(valObj).every(([tag, val]) => {
							switch (val) {
								case "has":
									return (mod.tags || []).includes(tag);
								case "lacks":
									return !(mod.tags || []).includes(tag);
								default:
									return true;
							}
						});
					break;
				}
				case "upd":
					modifier = (mod) => value == "any" || (value == "has" ? !!updateObj[mod.path] : !updateObj[mod.path]);
					break;
				default:
					return;
			}
			newList = newList.filter(modifier);
		});

		if (category.size > 0) newList = newList.filter((mod) => category.has(mod.parent));
		switch (sort) {
			case "fav-asc":
				newList.sort((a, b) => {
					const aFav = a.tags?.includes("fav") ? 1 : 0;
					const bFav = b.tags?.includes("fav") ? 1 : 0;
					return bFav - aFav || a.name.localeCompare(b.name);
				});
				break;
			case "fav-desc":
				newList.sort((a, b) => {
					const aFav = a.tags?.includes("fav") ? 1 : 0;
					const bFav = b.tags?.includes("fav") ? 1 : 0;
					return aFav - bFav || a.name.localeCompare(b.name);
				});
				break;
		}
		const regularMods = newList.filter((mod) => !isModBlacklisted(mod.tags));
		const blacklistedMods = newList.filter((mod) => isModBlacklisted(mod.tags));
		return [...regularMods, ...blacklistedMods];
	}, [category, filter, modList, search, searchDB, sort, updateObj]);

	const currentKey = useMemo(
		() => `${source}-${JSON.stringify(filter)}-${Array.from(category).join(",")}-${search}-${modList.length}-${sort}`,
		[category, filter, modList.length, search, sort, source]
	);
	const columnCount = Math.max(1, Math.floor(Math.max(containerWidth, CARD_COLUMN_WIDTH) / CARD_COLUMN_WIDTH));
	const rowCount = Math.ceil(filteredList.length / columnCount);
	// TanStack Virtual intentionally owns mutable scroll measurements outside React memoization.
	// eslint-disable-next-line react-hooks/incompatible-library
	const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: rowCount,
		getScrollElement: () => containerRef.current,
		estimateSize: () => CARD_ROW_SIZE,
		getItemKey: (index) => `${currentKey}:${index}`,
		overscan: VIRTUAL_OVERSCAN_ROWS,
	});
	const virtualRows = rowVirtualizer.getVirtualItems();
	const visiblePreviewPaths = useMemo(
		() =>
			virtualRows.flatMap((row) =>
				filteredList.slice(row.index * columnCount, (row.index + 1) * columnCount).map((mod) => mod.path)
			),
		[columnCount, filteredList, virtualRows]
	);

	useEffect(() => {
		containerRef.current?.scrollTo({ top: 0 });
	}, [currentKey]);

	useEffect(() => {
		requestVisiblePreviewAssets(game, visiblePreviewPaths);
	}, [game, visiblePreviewPaths]);

	const setContainerElement = useCallback((element: HTMLDivElement | null) => {
		resizeObserverRef.current?.disconnect();
		resizeObserverRef.current = null;
		containerRef.current = element;
		if (!element) return;

		setContainerWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		resizeObserverRef.current = new ResizeObserver(([entry]) => {
			const width = Math.floor(entry.contentRect.width);
			setContainerWidth((current) => (current === width ? current : width));
		});
		resizeObserverRef.current.observe(element);
	}, []);

	const handleClick = async (event: MouseEvent, mod: Mod) => {
		const tag = (event.target as HTMLElement).tagName.toLowerCase();
		if (tag == "button") return;
		if (event.button == toggleOn) {
			const success = await toggleMod(mod.path, !mod.enabled);
			info("[IMM] Toggled mod:", mod.path, !mod.enabled, success);
			if (success) {
				setModList((current) =>
					current.map((item) => (item.path == mod.path ? { ...item, enabled: !item.enabled } : item))
				);
			}
		} else {
			setSelected(mod.path == selected ? "" : mod.path);
		}
	};

	return (
		<div className="flex h-screen w-full flex-col items-center overflow-hidden duration-300">
			<label className="text-muted z-200 flex shrink-0 flex-col items-center gap-1">
				<label className="flex items-center">
					{filteredList.length} {textData.Items}
				</label>
				<label className="text-xs">
					in{" "}
					<label
						onClick={() => void openManagedFolder("source", managedSRC)}
						className="pointer-events-auto text-blue-300 opacity-50 duration-200 hover:opacity-75"
					>
						{source.split("\\").slice(-2).join("\\")}\{managedSRC}
					</label>
				</label>
			</label>
			{filteredList.length === 0 ? (
				<div className="text-muted flex min-h-0 flex-1 items-center justify-center">
					<label>{textData._Main._MainLocal.NoMods}</label>
				</div>
			) : (
				<div ref={setContainerElement} className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto">
					<div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
						{virtualRows.map((virtualRow) => {
							const rowStart = virtualRow.index * columnCount;
							const rowMods = filteredList.slice(rowStart, rowStart + columnCount);
							return (
								<div
									key={virtualRow.key}
									className="absolute left-0 top-0 grid w-full justify-center"
									style={{
										height: `${CARD_HEIGHT}px`,
										gridTemplateColumns: `repeat(${columnCount}, ${CARD_COLUMN_WIDTH}px)`,
										transform: `translateY(${virtualRow.start + 16}px)`,
									}}
								>
									{rowMods.map((mod, columnIndex) => (
										<motion.div
											key={mod.path}
											className="flex h-full w-64 justify-center"
											initial={{ opacity: 0, y: 12 }}
											animate={{ opacity: 1, y: 0 }}
											transition={{
												duration: 0.2,
												ease: "easeOut",
												delay: Math.min(columnIndex * 0.025, 0.1),
											}}
											onMouseUp={(event) => void handleClick(event.nativeEvent, mod)}
											onContextMenu={preventContextMenu}
										>
											<CardLocal
												item={mod}
												game={game}
												selected={selected === mod.path}
												hasUpdate={updateObj[mod.path]}
												updateAvl={textData.UpdateAvl}
												inConflict={conflicts.mods[mod.path] ?? -1}
												isBlacklisted={isModBlacklisted(mod.tags)}
												blacklistedLabel={(textData as { Blacklisted?: string }).Blacklisted || "Blacklisted"}
											/>
										</motion.div>
									))}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}

export default MainLocal;
