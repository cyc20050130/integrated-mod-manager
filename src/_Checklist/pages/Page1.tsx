import { Button } from "@/components/ui/button";
import { LANG_LIST } from "@/utils/consts";
import { resetWithBackup } from "@/utils/filesys";
import TEXT from "@/textData.json";
import { MAIN_FUNC_STATUS, SAVED_LANG } from "@/utils/vars";
import { useAtom, useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

let interval: number | null = null;
let loadTime: number | null = null;
let timer: number | null = null;
function Page1({ setPage }: { setPage: (page: number) => void }) {
	const [selectedIndex, setSelectedIndex] = useState(-1);
	const [currentLangIndex, setCurrentLangIndex] = useState(-1);
	const mainFuncStatus = useAtomValue(MAIN_FUNC_STATUS);
	const escPressRef = useRef({ count: 0, lastTime: 0 });
	const languageKeys = ["en", "cn", "ru", "jp", "kr"] as const;
	const [savedLang, setSavedLang] = useAtom(SAVED_LANG);
	useEffect(() => {
		if (savedLang && mainFuncStatus=="fin" && !timer) {
			timer = setTimeout(
				() => {
					setPage(1);
					timer = null;
				},
				loadTime ? Math.max(0, 1500 - (Date.now() - loadTime)) : 1500
			);
		}
	}, [savedLang,mainFuncStatus]);
	useEffect(() => {
		loadTime = Date.now();
		interval = setInterval(() => {
			setCurrentLangIndex((prev) => (prev + 1) % languageKeys.length);
		}, 2000);

		return () => {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		};
	}, []);
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			const now = Date.now();
			const state = escPressRef.current;
			if (now - state.lastTime <= 300) state.count += 1;
			else state.count = 1;
			state.lastTime = now;
			if (state.count >= 3) {
				resetWithBackup();
				state.count = 0;
				state.lastTime = 0;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);
	return (
		<div className="text-muted-foreground  font-en fixed flex flex-col items-center justify-center w-screen h-screen gap-2">
			<div className="text-foreground flex text-6xl">
				{"Integrated".split("").map((letter, index) => (
					<span
						key={index}
						className="wave-letter"
						style={{
							animationDelay: `${index * 0.075}s`,
						}}
					>
						{letter}
					</span>
				))}
			</div>
			<div className=" text-accent textaccent flex text-4xl">
				{"Mod Manager".split("").map((letter, index) => (
					<span
						key={index}
						className="wave-letter"
						style={{
							animationDelay: `${(index + "aaaa".length) * 0.075}s`,
						}}
					>
						{letter === " " ? "\u00A0" : letter}
					</span>
				))}
			</div>

			<div className="fade-in justify-evenly absolute bottom-0 flex flex-col items-center h-64 gap-8">
				<AnimatePresence mode="wait">
					{mainFuncStatus === "fin" && !savedLang && currentLangIndex > -1 && (
						<motion.div
							key={currentLangIndex}
							initial={{ opacity: 0, y: 0 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 0 }}
							transition={{ duration: 0.4, ease: "easeInOut" }}
							className="text-accent/80 text-xl text-center"
						>
							{TEXT[languageKeys[currentLangIndex]].SelectLang}
						</motion.div>
					)}
				</AnimatePresence>

				<AnimatePresence>
					{mainFuncStatus === "fin" && !savedLang && currentLangIndex > -1 && (
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.4, ease: "easeInOut" }}
							className="flex justify-center gap-8 opacity-0"
						>
							{LANG_LIST.map((lang, index) => (
								<div
									key={lang.Code}
									className={`hover:brightness-110 group hover:scale-125 bg-accent/20 px-1 rounded-sm -mt-2 flex-col flex items-center justify-center gap-1 text-sm duration-300 cursor-pointerx select-none`}
									style={{
										background: selectedIndex == index ? "" : "#0000",
										scale: selectedIndex == index ? "1.25" : "",
									}}
									onClick={() => {
										setSelectedIndex(index);
										setCurrentLangIndex(index);
									}}
								>
									<img
										onMouseEnter={() => {
											if (interval) {
												clearInterval(interval);
												interval = null;
											}
											setCurrentLangIndex(index);
										}}
										onMouseLeave={() => {
											if (!interval) {
												if (selectedIndex === -1)
													interval = setInterval(() => {
														setCurrentLangIndex((prev) => (prev + 1) % languageKeys.length);
													}, 2000);
												else {
													setCurrentLangIndex(selectedIndex);
												}
											}
										}}
										src={lang.Flag}
										alt={lang.Name}
										className="w-8 h-8 duration-300"
									/>
									<span
										className="text-accent group-hover:opacity-50 whitespace-nowrap absolute mt-16 overflow-hidden duration-300 opacity-0"
										style={{
											opacity: selectedIndex == index ? "1" : "",
											scale: selectedIndex == index ? "0.8" : "0.7",
										}}
									>
										{lang.Name}
									</span>
								</div>
							))}
						</motion.div>
					)}
				</AnimatePresence>
				<AnimatePresence mode="wait">
					{mainFuncStatus === "fin" && !savedLang && currentLangIndex > -1 && selectedIndex > 0 && (
						<motion.div
							key={selectedIndex}
							initial={{ opacity: 0, y: 0 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 0 }}
							transition={{ duration: 0.4, ease: "easeInOut" }}
							className="opacity-20 text-accent bottom-2 right-1 max-w-1/3 fixed flex flex-col mt-4 text-sm text-center"
						>
							<span>{TEXT[languageKeys[selectedIndex]].Warning1}</span>
							{TEXT[languageKeys[selectedIndex]].Warning2}
						</motion.div>
					)}
				</AnimatePresence>

				<Button
					className="w-fit "
					style={{ opacity: mainFuncStatus !== "fin" || !!savedLang || currentLangIndex < 0 ? 0 : selectedIndex == -1 ? 0.5 : 1 }}
					disabled={selectedIndex == -1 || !!savedLang || currentLangIndex < 0 || mainFuncStatus !== "fin"}
					onClick={() => {
						setSavedLang(languageKeys[selectedIndex]);
						setPage(1);
					}}
				>
					Confirm
				</Button>
				<div
				className="duration-300 opacity-0"
				style={{
					opacity:mainFuncStatus === "fin" ? 0:0.5
				}}
				>
					{mainFuncStatus==="fin"?"Initialization complete":mainFuncStatus}
				</div>
			</div>
		</div>
	);
}
export default Page1;
