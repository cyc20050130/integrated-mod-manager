import { useAtom, useAtomValue, useSetAtom } from "jotai";
import "./App.css";
import {
	CHANGES,
	ERR,
	GAME,
	INIT_DONE,
	LANG,
	LEFT_SIDEBAR_OPEN,
	MOD_LIST,
	ONLINE,
	PROGRESS_OVERLAY,
	RIGHT_SIDEBAR_OPEN,
	RIGHT_SLIDEOVER_OPEN,
	SETTINGS,
} from "./utils/vars";
import { AnimatePresence, motion } from "motion/react";
import Checklist from "./_Checklist/Checklist";
import { initializeThemes } from "./utils/theme";
import Changes from "./_Changes/Changes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { refreshModList, saveConfigs } from "./utils/filesys";
import { SidebarProvider } from "./components/ui/sidebar";
import LeftSidebar from "./_LeftSidebar/Left";
import Main from "./_Main/Main";
import RightLocal from "./_RightSidebar/RightLocal";
import RightOnline from "./_RightSidebar/RightOnline";
import { main } from "./utils/init";
import ToastProvider from "./_Toaster/ToastProvider";
import Progress from "./_Progress/Progress";
// import { Button } from "./components/ui/button";

initializeThemes();
main();
function App() {
	const initDone = useAtomValue(INIT_DONE);
	const lang = useAtomValue(LANG);
	const err = useAtomValue(ERR);
	const online = useAtomValue(ONLINE);
	const game = useAtomValue(GAME);
	const changes = useAtomValue(CHANGES);
	const settings = useAtomValue(SETTINGS);
	const leftSidebarOpen = useAtomValue(LEFT_SIDEBAR_OPEN);
	// const setOnlineSelected = useSetAtom(ONLINE_SELECTED);
	const [rightSidebarOpen, setRightSidebarOpen] = useAtom(RIGHT_SIDEBAR_OPEN);
	const [rightSlideOverOpen, setRightSlideOverOpen] = useAtom(RIGHT_SLIDEOVER_OPEN);
	const setModList = useSetAtom(MOD_LIST);
	const progressOverlay = useAtomValue(PROGRESS_OVERLAY);
	const [_, setShowModeSwitch] = useState(false);
	const [previousOnline, setPreviousOnline] = useState(online);
	const afterInit = useCallback(async () => {
		saveConfigs();
		setModList(await refreshModList());
		return Promise.resolve();
	}, []);
	useEffect(() => {
		if (err) {
			throw new Error(err);
		}
	}, [err]);
	useEffect(() => {
		if (previousOnline !== online) {
			setShowModeSwitch(true);
			setPreviousOnline(online);
			const timer2 = setTimeout(() => {
				setRightSidebarOpen(!online);
			}, 300);

			const timer = setTimeout(() => {
				setShowModeSwitch(false);
			}, 1000);

			return () => {
				clearTimeout(timer);
				clearTimeout(timer2);
			};
		}
		return undefined;
	}, [online]);
	const leftSidebarStyle = useMemo(
		() => ({
			minWidth: leftSidebarOpen ? "20.95rem" : "3.95rem",
		}),
		[leftSidebarOpen]
	);
	const rightSidebarStyle = useMemo(
		() => ({
			minWidth: rightSidebarOpen ? "20.95rem" : "0rem",
		}),
		[rightSidebarOpen]
	);
	return (
		<div id="background" className="game-font fixed border-b flex flex-row items-start justify-start w-full h-full">
			<div
				className="bg-bgg fixed w-screen h-screen"
				style={{
					opacity: (settings.global.bgOpacity || 1) * 0.1,
					animation: settings.global.bgType == 2 ? "moveDiagonal 15s linear infinite" : "",
					backgroundImage: settings.global.bgType == 0 ? "none" : "",
					backgroundRepeat: settings.global.bgType == 0 ? "no-repeat" : "",
				}}
			></div>
			<SidebarProvider open={leftSidebarOpen}>
				<LeftSidebar />
			</SidebarProvider>
			<SidebarProvider open={rightSidebarOpen}>
				<RightLocal />
			</SidebarProvider>
			<RightOnline open={online && rightSlideOverOpen} />
			<div className="fixed flex flex-row w-full h-full">
				<div className="h-full duration-200 ease-linear" style={leftSidebarStyle} />
				<Main />
				<div className="h-full duration-300 ease-linear" style={rightSidebarStyle} />
			</div>
			<div className="fixed flex flex-row w-full h-full pointer-events-none">
				<div className="h-full duration-200 ease-linear" style={leftSidebarStyle} />
				<AnimatePresence>
					{online && rightSlideOverOpen && (
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.3 }}
							onClick={() => setRightSlideOverOpen(false)}
							className="w-full pointer-events-auto h-full bg-background/40 backdrop-blur-[2px]"
						/>
					)}
				</AnimatePresence>
			</div>
			
			
			<div id="mods-progress-container" className="fixed pointer-events-none -bottom-12 duration-300 text-[8px] opacity-50 rounded-tl-md flex pl-2 gap-1.5 flex-row items-center right-0 h-8 w-72 bg-sidebar border z-10">
				Mods Checked :
				<div className="w-42 border flex h-4 rounded-sm overflow-hidden">
					<div id="mods-progress" className="bg-accent duration-100 h-full rounded-r-sm"></div>
				</div>
				<div className="flex font-en min-w-fit text-center flex-col">
					<label id="mods-checked">88</label>
					<div className="w-full h-[1px] bg-border rounded-full"></div>
					<label id="mods-total">9999</label>
				</div>
			</div>
			<AnimatePresence>{(!initDone || !lang || !game) && <Checklist />}</AnimatePresence>
			<AnimatePresence>{changes.title && <Changes afterInit={afterInit} />}</AnimatePresence>
			<AnimatePresence>{progressOverlay.open && <Progress />}</AnimatePresence>
			<ToastProvider />
		</div>
	);
}
export default App;
