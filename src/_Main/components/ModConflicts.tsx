import CardLocal from "@/_Main/components/CardLocal";
import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toggleMod } from "@/utils/filesys";

import { CONFLICT_INDEX, CONFLICTS, MOD_LIST, TEXT_DATA } from "@/utils/vars";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

function ModConflicts() {
	const setModList = useSetAtom(MOD_LIST);
	const { conflicts } = useAtomValue(CONFLICTS);
	const [curIndex, setCurIndex] = useAtom(CONFLICT_INDEX);
	const [curSelected, setCurSelected] = useState(-1);
	const [nextSide, setNextSide] = useState<"left" | "right">("right");
	const textData = useAtomValue(TEXT_DATA);
	const safeIndex = useMemo(() => {
		if (!conflicts.length) return 0;
		return Math.min(curIndex, conflicts.length - 1);
	}, [conflicts, curIndex]);
	const currentConflict = conflicts[safeIndex] || [];

	return (
		<DialogContent>
			<Tooltip>
				<TooltipTrigger></TooltipTrigger>
				<TooltipContent className="opacity-0"></TooltipContent>
			</Tooltip>

			<div className="min-h-fit text-accent mt-6 text-3xl">{textData._Main._components._ModConflicts.ResModConf}</div>
			<AnimatePresence mode="wait">
				{conflicts.length > 0 ? (
					<motion.div
						className="max-h-100 relative min-h-100 flex flex-col w-full h-full p-2 pt-6 overflow-x-hidden overflow-y-scroll text-gray-300 rounded-sm"
						key={currentConflict[0] || `conflict-${safeIndex}`}
						initial={{
							opacity: 0,
							left: nextSide === "right" ? "10%" : "-10%",
						}}
						animate={{
							opacity: 1,
							left: 0,
						}}
						exit={{
							opacity: 0,
							left: nextSide === "right" ? "-10%" : "10%",
						}}
						transition={{
							duration: 0.3,
							ease: "easeInOut",
						}}
					>
						<div className="min-h-fit flex flex-row flex-wrap gap-10 justify-center w-full py-4">
							{currentConflict.map((path, idx) => (
								<div
									key={`${path}-${idx}`}
									onClick={(e) => {
										e.preventDefault();
										setCurSelected((prev) => (prev === idx ? -1 : idx));
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										setCurSelected((prev) => (prev === idx ? -1 : idx));
									}}
								>
									<CardLocal
										item={{
											path,
											name: path.split("\\").pop() || path,
											enabled: curSelected === -1 ? true : curSelected === idx,
											isDir: false,
										}}
										selected={curSelected === idx}
										lastUpdated={0}
										hasUpdate={false}
										updateAvl={""}
										key={idx}
										inConflict={0}
										isBlacklisted={false}
										blacklistedLabel={""}
									/>
								</div>
							))}
						</div>
					</motion.div>
				) : (
					<motion.div
						className="text-center w-full h-100 justify-center items-center flex text-gray-400"
						key="no-conflict"
						initial={{
							opacity: 0,
							scale: 1.1,
						}}
						animate={{
							opacity: 1,
							scale: 1,
						}}
						exit={{
							opacity: 0,
							scale: 0.9,
						}}
						transition={{
							duration: 0.3,
							ease: "easeInOut",
						}}
					>
						{textData._Main._components._ModConflicts.NoConf}
					</motion.div>
				)}
			</AnimatePresence>
			<div
				className="flex w-full justify-between"
				style={{
					opacity: conflicts.length > 0 ? "1" : "0",
					pointerEvents: conflicts.length > 0 ? "auto" : "none",
				}}
			>
				<Button
					disabled={safeIndex <= 0}
					onClick={() => {
						if (safeIndex > 0) {
							const newIndex = safeIndex - 1;
							setNextSide("left");
							setTimeout(() => {
								setCurIndex(newIndex);
							}, 50);
						}
					}}
					className="min-w-24"
				>
					{textData.Prev}
				</Button>
				<div className="w-full text-xs text-muted-foreground flex flex-col items-center justify-center">
					<div className="flex flex-row text-accent gap-1 mb-2 text-sm items-center justify-center px-10 w-full">
						{conflicts?.map((c, i) => (
							<div
								key={c[0]}
								className={`w-2.5 h-2.5 rounded-full cursor-pointer duration-200 ${
									i === safeIndex ? "bg-accent" : "border hover:bg-muted"
								}`}
								onClick={() => {
									setNextSide(i < safeIndex ? "left" : "right");
									setTimeout(() => {
										setCurIndex(i);
									}, 50);
								}}
							></div>
						))}
					</div>
					<div>{textData._Main._components._ModConflicts.Msg1}</div>
					<div>{textData._Main._components._ModConflicts.Msg2}</div>
				</div>
				<Button
					disabled={safeIndex >= conflicts.length - 1 && curSelected === -1}
					onClick={async () => {
						if (!currentConflict.length) return;
						const toDisable = curSelected < 0 ? [] : [...currentConflict].filter((_, idx) => idx !== curSelected);

						if (Array.isArray(toDisable) && toDisable.length > 0) {
							const results = await Promise.all(
								toDisable.map(async (path: string) => ({
									path,
									disabled: await toggleMod(path, false),
								}))
							);
							const disabledSet = new Set(results.filter((item) => item.disabled).map((item) => item.path));
							setNextSide("right");
							setCurSelected(-1);
							if (disabledSet.size > 0) {
								setModList((old) =>
									old.map((mod) => ({
										...mod,
										enabled: disabledSet.has(mod.path) ? false : mod.enabled,
									}))
								);
							}
						} else if (safeIndex < conflicts.length - 1) {
							const newIndex = safeIndex + 1;
							setNextSide("right");
							setCurSelected(-1);
							setTimeout(() => {
								setCurIndex(newIndex);
							}, 50);
						}
					}}
					className="min-w-24"
				>
					{curSelected >= 0 ? textData._Main._components._ModConflicts.Resolve : textData.Skip}
				</Button>
			</div>
		</DialogContent>
	);
}

export default ModConflicts;
