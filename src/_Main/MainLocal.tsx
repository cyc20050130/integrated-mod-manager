import {
	CATEGORY,
	CONFLICTS,
	FILTER,
	INIT_DONE,
	INSTALLED_ITEMS,
	LAST_UPDATED,
	MOD_LIST,
	openConflict,
	SEARCH,
	SELECTED,
	SETTINGS,
	SORT,
	SOURCE,
	TEXT_DATA,
} from "@/utils/vars";
import { useAtom, useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import CardLocal from "./components/CardLocal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { preventContextMenu } from "@/utils/utils";
import { toggleMod } from "@/utils/filesys";
import MiniSearch from "minisearch";
import { join, setChange } from "@/utils/hotreload";
import { managedSRC } from "@/utils/consts";
import { openPath } from "@tauri-apps/plugin-opener";
import { Mod } from "@/utils/types";
import { addToast } from "@/_Toaster/ToastProvider";
import { info } from "@/lib/logger";
// import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
// import { RefreshCwIcon } from "lucide-react";
// import { addToast } from "@/_Toaster/ToastProvider";

let searchDB: any = null;
let prev = "prev";
let prevEnabled = "noData";
let filterChangeCount = 0;
let timeout: any = null;
function MainLocal() {
	const initDone = useAtomValue(INIT_DONE);
	const textData = useAtomValue(TEXT_DATA);
	const [conflicts, setConflicts] = useAtom(CONFLICTS);
	const [initial, setInitial] = useState(true);
	const lastUpdated = useAtomValue(LAST_UPDATED);
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
	const source = useAtomValue(SOURCE);
	const [filteredList, setFilteredList] = useState([] as Mod[]);
	const [visibleRange, setVisibleRange] = useState({ start: -1, end: -1 });
	const [selected, setSelected] = useAtom(SELECTED);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const toggleOn = useAtomValue(SETTINGS).global.toggleClick;
	const sort = useAtomValue(SORT);
	const scrollTimeoutRef = useRef<number | null>(null);
	// const scrollIntervalRef = useRef<NodeJS.Timeout | null>(null);
	const keyRef = useRef<string | null>(null);
	useEffect(() => {
		if (!searchDB && modList.length > 0) {
			searchDB = new MiniSearch({
				idField: "path",
				fields: ["name", "parent", "path"],
				storeFields: Object.keys(modList[0]),
				searchOptions: { prefix: true, fuzzy: 0.2 },
			});
		}
		if (searchDB) {
			searchDB.removeAll();
			searchDB.addAll(modList);
		}

		if (!initDone) {
			prevEnabled = "noData";
		} else {
			const enabled = modList
				.filter((m) => m.enabled)
				.map((m) => m.path)
				.join(",");
			if (prevEnabled !== enabled) {
				if (timeout) {
					clearTimeout(timeout);
				}
				timeout = setTimeout(() => {
					setChange();
				}, 250);
			}

			prevEnabled = enabled;
		}
		function checkForHashCollisions() {
			const allHashes: { [key: string]: Set<string> } = {};
			const hashes: { [key: string]: string[] } = {};
			[...modList]
				.sort((a, b) => a.path.localeCompare(b.path))
				.forEach((mod) => {
					if (mod.hashes) {
						mod.hashes.forEach((hash) => {
							if (mod.enabled) {
								if (!hashes[hash]) {
									hashes[hash] = [];
								}
								hashes[hash].push(mod.path);
							}
							if (!allHashes[hash]) {
								allHashes[hash] = new Set();
							}
							allHashes[hash].add(mod.parent);
						});
					}
				});
			const validHashes = Object.entries(allHashes).filter(([_, parents]) => parents.size == 1);
			const collisions = Object.entries(hashes).filter(
				([hash, paths]) => paths.length > 1 && validHashes.some(([vHash]) => vHash == hash)
			);
			let newCols = {} as any;
			collisions.forEach(([_, paths]) => {
				const key = paths[0];
				newCols[key] = (newCols as any)[key] || new Set();
				paths.slice(1).forEach((p) => {
					newCols[key].add(p);
				});
			});
			const modsInvolved = {} as Record<string, number>;
			newCols = Object.keys(newCols).map((key, i) => {
				const paths = [key, ...[...newCols[key]]];
				paths.forEach((p) => {
					modsInvolved[p] = modsInvolved[p] || i;
				});
				return paths;
			});

			if (collisions.length > 0 && JSON.stringify(conflicts.conflicts) !== JSON.stringify(newCols)) {
				addToast({
					type: "error",
					message: textData._Toasts.CollisionsDetected,
					onClick: openConflict,
				});
				setConflicts({ conflicts: newCols, mods: modsInvolved });
			} else if (collisions.length == 0) {
				setConflicts({ conflicts: [], mods: {} });
			}
		}
		checkForHashCollisions();
	}, [modList]);
	useEffect(() => {
		filterChangeCount += 1;
	}, [filter, category, search, sort]);
	useEffect(() => {
		keyRef.current = `${filter}-${category}-${search}-${modList.length}-${filterChangeCount}-${sort}`;
		if (prev !== keyRef.current) {
			if (containerRef.current) {
				containerRef.current.scrollTo({ top: 0 });
			}
			setVisibleRange({ start: -1, end: -1 });
			setInitial(true);
		}
		prev = keyRef.current;
		let newList: Mod[] = searchDB && search ? searchDB.search(search) : [...modList];

		// let enb = filters.shift() || "All";
		// if (enb != "All") {
		// 	newList = newList.filter((mod) => mod.enabled == (enb == "Enabled"));
		// }
		Object.entries(filter).forEach(([key, value]) => {
			let modifier = (mod: Mod) => !!mod;
			switch (key) {
				case "src":
					modifier = (mod) => value == "any" || (value == "has" ? !!mod.source : !mod.source);
					break;
				case "st":
					modifier = (mod) => value == "all" || (value == "enabled" ? mod.enabled : !mod.enabled);
					break;
				case "tag":
					const valObj = value as { [key: string]: string };
					modifier = (mod) => {
						return Object.entries(valObj).every(([tag, val]) => {
							switch (val) {
								case "has":
									return (mod.tags || []).includes(tag);
								case "lacks":
									return !(mod.tags || []).includes(tag);
								default:
									return true;
							}
						});
					};
					break;
				case "upd":
					modifier = (mod) => value == "any" || (value == "has" ? !!updateObj[mod.path] : !updateObj[mod.path]);
					break;
				default:
					return;
			}
			newList = newList.filter((mod) => modifier(mod));
		});

		if (category.size > 0) {
			newList = newList.filter((mod) => category.has(mod.parent));
		}
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

		setFilteredList(newList);
	}, [modList, filter, category, search, filterChangeCount, sort]);

	const handleClick = async (e: MouseEvent, mod: Mod) => {
		const click = e.button;
		let tag = (e.target as HTMLElement).tagName.toLowerCase();
		if (tag == "button") {
			return;
		}
		if (click == toggleOn) {
			const ct = (e.currentTarget as HTMLDivElement)?.firstElementChild?.firstElementChild
				?.nextElementSibling as HTMLImageElement;
			ct && (ct.style.filter = mod.enabled ? "brightness(0.5) saturate(0.5)" : "brightness(1) ");
			let success = await toggleMod(mod.path, !mod.enabled);
			console.log("Toggled mod:", mod.path, "New state:", !mod.enabled, "Success:", success);
			if (success)
				setModList((prev) => {
					return prev.map((m) => {
						if (m.path == mod.path) {
							return { ...m, enabled: !m.enabled };
						}
						return m;
					});
				});
		} else setSelected(mod.path == selected ? "" : mod.path);
	};
	const handleScroll = useCallback(() => {
		if (initial) {
			setInitial(false);
		}
		if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
		scrollTimeoutRef.current = setTimeout(() => {
			if (containerRef.current) {
				const box = containerRef.current.getBoundingClientRect();
				const scrollTop = containerRef.current.scrollTop;
				const itemHeight = 304;
				const itemWidth = 256;
				const itemsPerRow = Math.floor((box.width - 10) / itemWidth);
				info(itemsPerRow, itemWidth, box.width - 10);
				setVisibleRange({
					start: Math.floor(scrollTop / itemHeight) * itemsPerRow,
					end: Math.ceil((scrollTop + box.height) / itemHeight) * itemsPerRow - 1,
				});
			}
		}, 50);
	}, [initial]);

	// Memoize animation variants to prevent recreation on every render
	const animationVariants = useCallback(
		() => ({
			hidden: { opacity: initial ? 0 : 1, y: 20 },
			visible: { opacity: 1, y: 0 },
			exit: { opacity: initial ? 0 : 1, y: -20 },
			invisible: { opacity: 0 },
		}),
		[initial]
	);

	// Memoize transition config
	const transitionConfig = useCallback(
		(index: number) => ({
			duration: 0.3,
			ease: "easeOut" as const,
			delay: initial ? 0.05 * index : 0,
		}),
		[initial]
	);

	// Determine if item should be visible
	const isItemVisible = useCallback(
		(index: number) => {
			const { start, end } = visibleRange;
			return start === -1 || (index >= start && index <= end) ? 0 : index < start ? 2 : 1;
		},
		[visibleRange]
	);
	const noItems = useMemo(() => {
		return (
			<div
				className="text-muted flex flex-col items-center justify-center w-full h-0 duration-200"
				style={{
					height: modList.length == 0 ? "100%" : "0px",
					opacity: modList.length == 0 ? 1 : 0,
				}}
			>
				<label>{textData._Main._MainLocal.NoMods}</label>
			</div>
		);
	}, [modList, source]);
	// info(conflicts);
	return (
		<>
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="flex flex-col items-center w-full h-screen overflow-x-hidden overflow-y-auto duration-300"
			>
				{" "}
				<label className="text-muted z-200 flex flex-col items-center gap-1">
					<label className="flex items-center">
						{filteredList.length} {textData.Items}{" "}
					</label>
					<label className="text-xs">
						in{" "}
						<label
							onClick={() => {
								openPath(join(source, managedSRC));
							}}
							className="hover:opacity-75 text-blue-300 duration-200 opacity-50 pointer-events-auto"
						>
							{source.split("\\").slice(-2).join("\\")}\{managedSRC}
						</label>
					</label>
				</label>
				{noItems}
				<AnimatePresence mode="popLayout">
					<motion.div
						layout
						className="min-h-fit card-grid grid justify-center w-full py-4"
						key={keyRef.current}
						initial={{ opacity: 0, pointerEvents: "none" }}
						animate={{ opacity: 1, pointerEvents: "auto" }}
						exit={{ opacity: 0, pointerEvents: "none" }}
						transition={{ ...transitionConfig(0) }}
					>
						{filteredList.map((mod, index) => {
							const isVisible = isItemVisible(index);

							return (
								<motion.div
									key={mod.path + keyRef.current}
									layout
									variants={animationVariants()}
									initial="hidden"
									animate="visible"
									exit="exit"
									transition={transitionConfig(index)}
									onMouseUp={(e: any) => handleClick(e, mod)}
									onContextMenu={preventContextMenu}
								>
									{isVisible ? (
										<div className="card-generic"></div>
									) : (
										<CardLocal
											item={mod}
											selected={selected === mod.path}
											lastUpdated={lastUpdated}
											hasUpdate={updateObj[mod.path]}
											updateAvl={textData.UpdateAvl}
											inConflict={conflicts.mods[mod.path] ?? -1}
										/>
									)}
								</motion.div>
							);
						})}
					</motion.div>
				</AnimatePresence>
			</div>
		</>
	);
}

export default MainLocal;
