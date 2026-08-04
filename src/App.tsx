import { useAtom, useAtomValue, useSetAtom } from "jotai";
import "./App.css";
import {
	BOOTSTRAP_STATE,
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
	TARGET,
} from "./utils/vars";
import { AnimatePresence, motion } from "motion/react";
import Checklist from "./_Checklist/Checklist";
import { initializeThemes } from "./utils/theme";
import Changes from "./_Changes/Changes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushRuntimeState, refreshModList, saveConfigs } from "./utils/filesys";
import { SidebarProvider } from "./components/ui/sidebar";
import LeftSidebar from "./_LeftSidebar/Left";
import Main from "./_Main/Main";
import RightLocal from "./_RightSidebar/RightLocal";
import RightOnline from "./_RightSidebar/RightOnline";
import { completeRuntimeBootstrap, failRuntimeBootstrap, main } from "./utils/init";
import ToastProvider from "./_Toaster/ToastProvider";
import Progress from "./_Progress/Progress";
import { startIntegrityMaintenanceOnLaunch } from "./utils/linkIntegrity";
import { startIniStateSync, stopIniStateSync, syncIniStateOnce } from "./utils/iniStateSync";
import { error as logError } from "./lib/logger";
import RecoveryCenter from "./_Recovery/RecoveryCenter";
import { getAppStateBootstrapStatus, type AppStateBootstrapStatus } from "./utils/appConfigRepository";
// import { Button } from "./components/ui/button";

initializeThemes();
let appMainStarted = false;
function App() {
	const initDone = useAtomValue(INIT_DONE);
	const bootstrapState = useAtomValue(BOOTSTRAP_STATE);
	const lang = useAtomValue(LANG);
	const err = useAtomValue(ERR);
	const online = useAtomValue(ONLINE);
	const game = useAtomValue(GAME);
	const changes = useAtomValue(CHANGES);
	const settings = useAtomValue(SETTINGS);
	const target = useAtomValue(TARGET);
	const leftSidebarOpen = useAtomValue(LEFT_SIDEBAR_OPEN);
	// const setOnlineSelected = useSetAtom(ONLINE_SELECTED);
	const [rightSidebarOpen, setRightSidebarOpen] = useAtom(RIGHT_SIDEBAR_OPEN);
	const [rightSlideOverOpen, setRightSlideOverOpen] = useAtom(RIGHT_SLIDEOVER_OPEN);
	const setModList = useSetAtom(MOD_LIST);
	const modList = useAtomValue(MOD_LIST);
	const progressOverlay = useAtomValue(PROGRESS_OVERLAY);
	const [_, setShowModeSwitch] = useState(false);
	const [previousOnline, setPreviousOnline] = useState(online);
	const [repositoryStatus, setRepositoryStatus] = useState<AppStateBootstrapStatus | null>(null);
	const initialIniSyncTargetRef = useRef("");
	const refreshedGenerationRef = useRef(-1);
	useEffect(() => {
		if (appMainStarted) return;
		let active = true;
		void getAppStateBootstrapStatus()
			.then((status) => {
				if (!active) return;
				setRepositoryStatus(status);
				if (status.status === "ready" && !appMainStarted) {
					appMainStarted = true;
					void main();
				}
			})
			.catch((statusError) => {
				if (active) logError("[IMM] Unable to read application state status:", statusError);
			});
		return () => {
			active = false;
		};
	}, []);
	const completeBootstrap = useCallback(() => {
		completeRuntimeBootstrap();
	}, []);
	useEffect(() => {
		if (!err) return;
		logError("[IMM] Runtime error:", err);
		failRuntimeBootstrap(err);
	}, [err]);
	useEffect(() => {
		if (bootstrapState.phase !== "ready") return;
		const generation = bootstrapState.generation;
		if (refreshedGenerationRef.current === generation) return;
		refreshedGenerationRef.current = generation;
		let active = true;
		void (async () => {
			await saveConfigs();
			const nextModList = await refreshModList();
			if (active) setModList(nextModList);
		})().catch((refreshError) => {
			if (active) logError("[IMM] Post-bootstrap Mod refresh failed:", refreshError);
		});
		return () => {
			active = false;
		};
	}, [bootstrapState.generation, bootstrapState.phase, setModList]);
	useEffect(() => {
		const handleBeforeUnload = () => {
			void flushRuntimeState("window-beforeunload");
		};
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, []);
	useEffect(() => {
		if (!initDone) return;
		void startIntegrityMaintenanceOnLaunch();
	}, [initDone]);
	useEffect(() => {
		if (!initDone || !target) {
			initialIniSyncTargetRef.current = "";
			void stopIniStateSync();
			return;
		}
		void startIniStateSync();
		return () => {
			void stopIniStateSync();
		};
	}, [initDone, target]);
	useEffect(() => {
		if (!initDone || !target || !modList.length) return;
		if (initialIniSyncTargetRef.current === target) return;
		initialIniSyncTargetRef.current = target;
		void syncIniStateOnce("app-init-sync");
	}, [initDone, target, modList]);
	useEffect(() => {
		if (previousOnline !== online) {
			queueMicrotask(() => {
				setShowModeSwitch(true);
				setPreviousOnline(online);
			});
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
	}, [online, previousOnline, setRightSidebarOpen]);
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
	if (repositoryStatus?.status === "recoveryRequired") {
		return <RecoveryCenter status={repositoryStatus} />;
	}
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

			<div
				id="mods-progress-container"
				className="fixed pointer-events-none -bottom-12 duration-300 text-[8px] opacity-50 rounded-tl-md flex pl-2 gap-1.5 flex-row items-center right-0 h-8 w-72 bg-sidebar border z-10"
			>
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
			<AnimatePresence>{(bootstrapState.phase !== "ready" || !lang || !game) && <Checklist />}</AnimatePresence>
			<AnimatePresence>{changes.title && <Changes onComplete={completeBootstrap} />}</AnimatePresence>
			<AnimatePresence>{progressOverlay.open && <Progress />}</AnimatePresence>
			<ToastProvider />
		</div>
	);
}
export default App;
