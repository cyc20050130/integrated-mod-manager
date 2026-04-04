import { skipPage } from "@/_Checklist/pages/Page3";
import { addToast } from "@/_Toaster/ToastProvider";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GAME_NAMES, LANG_LIST } from "@/utils/consts";
import { saveConfigs, setConfig } from "@/utils/filesys";
import { encodeHotkeyForStorage, formatHotkeyDisplay, processHotkeyCode } from "@/utils/hotkeyUtils";
import { join, setHotreload } from "@/utils/hotreload";
import { getCwd, setPrePostLaunch, setWindowType } from "@/utils/init";
import TEXT from "@/textData.json";
import { exportConfig, keySort } from "@/utils/utils";
import { INIT_DONE, PRESETS, SAVED_LANG, SETTINGS, SOURCE, store, TARGET, TEXT_DATA, XXMI_MODE } from "@/utils/vars";
import { DownloadSettings } from "@/utils/types";
import { DEFAULT_DOWNLOAD_SETTINGS } from "@/utils/downloads";
import { Separator } from "@radix-ui/react-separator";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue } from "jotai";
import {
	AppWindowIcon,
	CheckIcon,
	CircleSlashIcon,
	DownloadIcon,
	EyeClosedIcon,
	EyeIcon,
	EyeOffIcon,
	FocusIcon,
	Gamepad2Icon,
	Globe2,
	InfoIcon,
	Maximize2Icon,
	MouseIcon,
	MousePointerClickIcon,
	PauseIcon,
	PlayIcon,
	SettingsIcon,
	SquareIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
let bg: HTMLBodyElement | null = null;
let keys = [] as any[];
let keysdown = [] as any[];
function Settings({ leftSidebarOpen }: { leftSidebarOpen: boolean }) {
	const textData = useAtomValue(TEXT_DATA);
	const customMode = useAtomValue(XXMI_MODE);
	const [presets, setPresets] = useAtom(PRESETS);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [savedLang, setSavedLang] = useAtom(SAVED_LANG);
	const [alertType, setAlertType] = useState<"lang" | "xxmi">("lang");
	const [_, setSource] = useAtom(SOURCE);
	const [target, setTarget] = useAtom(TARGET);
	const [settings, setSettings] = useAtom(SETTINGS);
	const [alertOpen, setAlertOpen] = useState(false);
	const [globalPage, setGlobalPage] = useState(true);
	const [langAlertData, setLangAlertData] = useState({ prev: "en", new: "en" } as {
		prev: keyof typeof TEXT;
		new: keyof typeof TEXT;
	});
	const setDownloadNumber = (field: keyof DownloadSettings, min: number, max: number, raw: string) => {
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed)) return;
		const value = Math.max(min, Math.min(max, parsed));
		setSettings((prev) => {
			const current = prev.game.download || DEFAULT_DOWNLOAD_SETTINGS;
			prev.game.download = {
				...current,
				[field]: value,
			};
			return { ...prev };
		});
		saveConfigs();
	};
	const importConfig = async () => {
		try {
			const dialogOptions: any = {
				title: textData._LeftSideBar._components._Settings._ImportExport.ImportPop || "Import Config",
				filters: [
					{
						name: "JSON files",
						extensions: ["json", "json.bak", "json.bak.bak"],
					},
				],
			};

			dialogOptions.defaultPath = join(getCwd(), "backups");

			const filePath = await open(dialogOptions);

			if (filePath) {
				const content = await readTextFile(filePath as string);
				try {
					setConfig(JSON.parse(content));
					setSettingsOpen(false);
					addToast({ type: "success", message: textData._Toasts.ConfigImported });
				} catch {
					addToast({ type: "error", message: textData._Toasts.InvalidConfig });
				}
			}
		} catch (error) {
			addToast({ type: "error", message: textData._Toasts.ErrorImporting });
		}
	};
	
	return (
		<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
			<DialogTrigger asChild>
				<Button
					onClick={() => {}}
					className="w-38.75 text-ellipsis peer h-12 overflow-hidden"
					style={{ width: leftSidebarOpen ? "" : "3rem", borderRadius: leftSidebarOpen ? "" : "999px" }}
				>
					<SettingsIcon />
					{leftSidebarOpen && textData.Settings}
				</Button>
			</DialogTrigger>
			<DialogContent className="min-h-fit">
				<AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
					<AlertDialogContent className="game-font bg-background/50 backdrop-blur-xs border-border flex flex-col items-center gap-4 p-4 overflow-hidden border-2 rounded-lg"
					style={{
						minWidth:alertType === "xxmi"?"700px":"",
						maxWidth:alertType === "xxmi"?"700px":""
					}}
					>
						{alertType === "xxmi" ? (
							<>
								<div className=" flex flex-col items-center mt-6 text-center">
									<div className="flex flex-col items-center justify-center gap-2 mb-8 text-3xl text-gray-200">
										{textData._LeftSideBar._components._Settings._LaunchSettings.Note}
									</div>
									<img src="xxmi-warn.png" className="rounded-xl min-w-164 max-w-164" />
									<div className="h-12 w-49  -ml-85.25 -mt-15.5 border border-accent animate-pulse rounded-lg"/>
									
									<div className="text-accent mt-6">{textData._LeftSideBar._components._Settings._LaunchSettings.Warn1}</div>
									<div className="text-accent">{textData._LeftSideBar._components._Settings._LaunchSettings.Warn2}</div>
								</div>
								<div className="flex justify-center w-full gap-4 mt-4">
									<AlertDialogAction className="min-w-24 duration-300">{textData.Confirm}</AlertDialogAction>
								</div>
							</>
						) : (
							<>
								<div className=" flex flex-col items-center gap-6 mt-6 text-center">
									<div className="flex flex-col items-center justify-center gap-2 text-xl text-gray-200">
										{TEXT[langAlertData.prev].Change + TEXT[langAlertData.prev].Languages[langAlertData.new]}
										?
										<Separator />
										{TEXT[langAlertData.new].Change + TEXT[langAlertData.new].Languages[langAlertData.new]}?
									</div>

									{langAlertData.new !== "en" && (
										<div className="max-w-96 text-accent flex flex-col gap-4 text-sm">
											<span>
												{TEXT[langAlertData.prev].Warning1 + " "}
												{TEXT[langAlertData.prev].Warning2}
											</span>
											{langAlertData.new === "cn"
												? TEXT[langAlertData.prev].CredCN
												: langAlertData.new === "ru"
													? TEXT[langAlertData.prev].CredRU
													: ""}
											<span>
												{TEXT[langAlertData.new].Warning1 + " "}
												{TEXT[langAlertData.new].Warning2}
											</span>
											{langAlertData.new === "cn"
												? TEXT[langAlertData.new].CredCN
												: langAlertData.new === "ru"
													? TEXT[langAlertData.new].CredRU
													: ""}
										</div>
									)}
								</div>
								<div className="flex justify-between w-full gap-4 mt-4">
									<AlertDialogCancel className="min-w-24 duration-300">
										{TEXT[langAlertData.prev].Cancel} | {TEXT[langAlertData.new].Cancel}
									</AlertDialogCancel>
									<AlertDialogAction
										className="min-w-24 text-accent "
										onClick={() => {
											setSavedLang(langAlertData.new);
											setAlertOpen(false);
										}}
									>
										{TEXT[langAlertData.prev].Confirm} | {TEXT[langAlertData.new].Confirm}
									</AlertDialogAction>
								</div>
							</>
						)}
					</AlertDialogContent>
				</AlertDialog>
				<div className="min-h-fit text-accent my-6 text-3xl">
					{textData.Settings}
					<Tooltip>
						<TooltipTrigger></TooltipTrigger>
						<TooltipContent className="opacity-0"></TooltipContent>
					</Tooltip>
				</div>
				<Tabs
					defaultValue={globalPage ? "global" : "game"}
					onValueChange={(val) => setGlobalPage(val === "global")}
					className="w-full"
				>
					<TabsList className="bg-background/50 w-full gap-2">
						<TabsTrigger value="global" className="w-1/2 h-10">
							<Globe2 />
							{textData._LeftSideBar._components._Settings.Global}
						</TabsTrigger>
						<TabsTrigger value="game" className="w-1/2 h-10">
							<div
								className="height-2 aspect-square logo min-h-4 duration-300"
								style={{
									filter: !globalPage ? "invert(1) hue-rotate(180deg)" : "",
								}}
							></div>
							{GAME_NAMES[settings.global.game]}
						</TabsTrigger>
					</TabsList>
					<AnimatePresence mode="wait" initial={false}>
						<motion.div
							key={globalPage ? "global" : "game"}
							initial={{ opacity: 0, x: globalPage ? "-25%" : "25%" }}
							animate={{ opacity: 1, x: 0 }}
							exit={{ opacity: 0, x: globalPage ? "-25%" : "25%" }}
							transition={{ duration: 0.2 }}
							className="min-h-80 flex w-full gap-2"
						>
							{globalPage ? (
								<>
									<div className="min-w-1/2 justify-evenly flex flex-col min-h-full gap-4 pr-2">
										<div className="flex flex-col w-full gap-4">
											<label className="min-w-fit">{textData._LeftSideBar._components._Settings.Toggle}</label>
											<Tabs
												defaultValue={settings.global.toggleClick.toString()}
												className="w-full"
												onValueChange={(e) => {
													setSettings((prev) => {
														prev.global.toggleClick = parseInt(e) as 0 | 2;
														return { ...prev };
													});
													saveConfigs();
												}}
											>
												<TabsList className="bg-background/50 w-full">
													<TabsTrigger value="0" className="w-1/2 h-10">
														<MousePointerClickIcon className=" rotate-y-180 w-4 -mr-2" />
														<MouseIcon />
														{textData._LeftSideBar._components._Settings._Toggle.LeftClick}
													</TabsTrigger>
													<TabsTrigger value="2" className="w-1/2 h-10">
														<MouseIcon />
														<MousePointerClickIcon className=" w-4 -ml-2" />
														{textData._LeftSideBar._components._Settings._Toggle.RightClick}
													</TabsTrigger>
												</TabsList>
											</Tabs>
										</div>
										<div className="flex flex-col w-full gap-4">
											<label>{textData._LeftSideBar._components._Settings.WindowType}</label>
											<Tabs
												defaultValue={settings.global.winType.toString()}
												onValueChange={(e) => {
													setSettings((prev) => {
														prev.global.winType = parseInt(e) as 0 | 1 | 2;
														return { ...prev };
													});
													setWindowType(parseInt(e));
													saveConfigs();
												}}
												className="w-full"
											>
												<TabsList className="bg-background/50 w-full">
													<TabsTrigger value="0" className="w-1/2 h-10">
														<AppWindowIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._WindowType.Windowed}
													</TabsTrigger>
													{/* <TabsTrigger value="1" className="w-1/3 h-10">
														<MaximizeIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._WindowType.Borderless}
													</TabsTrigger> */}
													<TabsTrigger value="2" className="w-1/2 h-10">
														<Maximize2Icon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._WindowType.Fullscreen}
													</TabsTrigger>
												</TabsList>
											</Tabs>
										</div>
										<div className="flex flex-col w-full gap-4">
											<label className="min-w-fit">{textData._LeftSideBar._components._Settings.WindowBGOpacity}</label>
											<Slider
												defaultValue={[settings.global.bgOpacity * 100]}
												max={100}
												min={0}
												step={1}
												className="w-full m-1"
												onValueChange={(e) => {
													bg = bg || document.querySelector("body");
													if (bg)
														bg.style.backgroundColor = "color-mix(in oklab, var(--background) " + e + "%, transparent)";
												}}
												onValueCommit={(e) => {
													setSettings((prev) => {
														prev.global.bgOpacity = e[0] / 100;
														return { ...prev };
													});
													saveConfigs();
												}}
											/>
										</div>
									</div>
									<div className="min-w-1/2 justify-evenly flex flex-col min-h-full gap-4 pr-2">
										<div className="flex flex-col w-full gap-4">
											<div className="flex items-center gap-1">
												{textData._LeftSideBar._components._Settings.NSFW}
												<Tooltip>
													<TooltipTrigger>
														<InfoIcon className="text-muted-foreground hover:text-gray-300 w-4 h-4" />
													</TooltipTrigger>
													<TooltipContent>
														<div className="flex flex-col gap-1">
															<div>
																<b>{textData._LeftSideBar._components._Settings._NSFW.Remove} -</b>{" "}
																{textData._LeftSideBar._components._Settings._NSFW.RemoveMsg}
															</div>
															<div>
																<b>{textData._LeftSideBar._components._Settings._NSFW.Blur} -</b>{" "}
																{textData._LeftSideBar._components._Settings._NSFW.BlurMsg}
															</div>
															<div>
																<b>{textData._LeftSideBar._components._Settings._NSFW.Show} -</b>{" "}
																{textData._LeftSideBar._components._Settings._NSFW.ShowMsg}
															</div>
														</div>
													</TooltipContent>
												</Tooltip>
											</div>
											<Tabs
												defaultValue={settings.global.nsfw.toString()}
												onValueChange={(e) => {
													setSettings((prev) => {
														prev.global.nsfw = parseInt(e) as 0 | 1 | 2;
														return { ...prev };
													});
													saveConfigs();
												}}
												className="w-full"
											>
												<TabsList className="bg-background/50 w-full">
													<TabsTrigger value="0" className="w-1/3 h-10">
														<EyeOffIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._NSFW.Remove}
													</TabsTrigger>
													<TabsTrigger value="1" className="w-1/3 h-10">
														<EyeClosedIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._NSFW.Blur}
													</TabsTrigger>
													<TabsTrigger value="2" className="w-1/3 h-10">
														<EyeIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._NSFW.Show}
													</TabsTrigger>
												</TabsList>
											</Tabs>
										</div>
										<div className="flex flex-col w-full gap-4">
											<label>{textData._LeftSideBar._components._Settings.BgType}</label>
											<Tabs
												defaultValue={settings.global.bgType.toString()}
												onValueChange={(e) => {
													setSettings((prev) => {
														prev.global.bgType = parseInt(e) as 0 | 1 | 2;
														return { ...prev };
													});
													saveConfigs();
												}}
												className="w-full"
											>
												<TabsList className="bg-background/50 w-full">
													<TabsTrigger value="0" className="w-1/3 h-10">
														<SquareIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._BgType.Blank}
													</TabsTrigger>
													<TabsTrigger value="1" className="w-1/3 h-10">
														<PauseIcon className="aspect-square h-full pointer-events-none" />{" "}
														{textData._LeftSideBar._components._Settings._BgType.Static}
													</TabsTrigger>
													<TabsTrigger value="2" className="w-1/3 h-10">
														<PlayIcon className="aspect-square h-full pointer-events-none" />
														{textData._LeftSideBar._components._Settings._BgType.Dynamic}
													</TabsTrigger>
												</TabsList>
											</Tabs>
										</div>
										<div className="flex flex-col w-full gap-4">
											<label>{textData.Language}</label>
											<div className="justify-evenly flex">
												{LANG_LIST.map((lang) => (
													<div
														key={lang.Code}
														className={`hover:brightness-150 -mt-2 flex-col flex items-center justify-center gap-1 text-sm duration-300 cursor-pointerx select-none`}
														onClick={() => {
															if (savedLang == lang.Code) return;
															setLangAlertData({
																prev: savedLang || "en",
																new: lang.Code as keyof typeof TEXT,
															});
															setAlertType("lang");
															setAlertOpen(true);
														}}
													>
														<img src={lang.Flag} alt={lang.Name} className="hover:scale-120 w-6 h-6 duration-200" />
														<span
															className="text-accent whitespace-nowrap absolute mt-12 overflow-hidden duration-200"
															style={{
																opacity: savedLang == lang.Code ? "1" : "0",
															}}
														>
															{lang.Name}
														</span>
													</div>
												))}
											</div>
										</div>
									</div>
								</>
							) : (
								<>
									<div className="min-w-1/2 justify-evenly flex flex-col min-h-full gap-4 pr-2">
										<div className="flex flex-col w-full gap-4">
											<div className="flex items-center gap-1">
												{textData._LeftSideBar._components._Settings.AutoReload}
												<Tooltip>
													<TooltipTrigger>
														<InfoIcon className="text-muted-foreground hover:text-gray-300 w-4 h-4" />
													</TooltipTrigger>
													<TooltipContent>
														<div className="flex flex-col gap-1">
															<div>
																<b>{textData._LeftSideBar._components._Settings._AutoReload.Disable} -</b>{" "}
																{textData._LeftSideBar._components._Settings._AutoReload.DisableMsg}
															</div>
															<div>
																<b>IMM -</b> {textData._LeftSideBar._components._Settings._AutoReload.WWMMMsg}
															</div>
															<div>
																<b>{textData._LeftSideBar._components._Settings._AutoReload.OnFocus} -</b>{" "}
																{textData._LeftSideBar._components._Settings._AutoReload.FocusMsg}
															</div>
															<Separator />
															<div>{textData._LeftSideBar._components._Settings._AutoReload.ReloadMsg}</div>
														</div>
													</TooltipContent>
												</Tooltip>
											</div>
											<Tabs
												defaultValue={settings.game.hotReload.toString()}
												className="w-full"
												onValueChange={(e: any) => {
													e = parseInt(e) as 0 | 1 | 2;
													setSettings((prev) => {
														prev.game.hotReload = e;
														return { ...prev };
													});
													setHotreload(e, settings.global.game, target);
													saveConfigs();
												}}
											>
												<TabsList className="bg-background/50 w-full">
													<TabsTrigger value="0" className="w-1/3 h-10">
														<CircleSlashIcon />
														{textData._LeftSideBar._components._Settings._AutoReload.Disable}
													</TabsTrigger>
													<TabsTrigger value="1" className="w-1/3 h-10">
														<AppWindowIcon />
														IMM
													</TabsTrigger>
													<TabsTrigger value="2" className="w-1/3 h-10">
														<FocusIcon />
														{textData._LeftSideBar._components._Settings._AutoReload.OnFocus}
													</TabsTrigger>
												</TabsList>
											</Tabs>
										</div>
										<div className="flex flex-col w-full gap-4">
											<div className="flex items-center gap-1">
												{textData._LeftSideBar._components._Settings.LaunchSettings}
												<Tooltip>
													<TooltipTrigger>
														<InfoIcon className="text-muted-foreground hover:text-gray-300 w-4 h-4" />
													</TooltipTrigger>
													<TooltipContent>
														<div className="flex flex-col gap-1">
															<div>
																<b>{textData._LeftSideBar._components._Settings._AutoReload.Disable} -</b> {textData._LeftSideBar._components._Settings._LaunchSettings.NoChanges}
															</div>
															<div>
																<b>IMM -</b> {textData._LeftSideBar._components._Settings._LaunchSettings.LaunchGame}
															</div>
															<div>
																<b>{settings.global.game}MI -</b> {textData._LeftSideBar._components._Settings._LaunchSettings.LaunchIMM.replace("<game/>", settings.global.game)}
															</div>
														</div>
													</TooltipContent>
												</Tooltip>
											</div>
											<Tabs
												defaultValue={settings.game.launch.toString()}
												className=" w-full duration-200"
												style={
													customMode
														? {
																pointerEvents: "none",
																filter: "brightness(0.5)",
															}
														: {}
												}
												onValueChange={(e) => {
													let val = parseInt(e) as 0 | 1 | 2;
													if (val == 2 || settings.game.launch == 2) setPrePostLaunch(settings.global.game, val == 2);
													if (val == 2) {
														setAlertType("xxmi");
														setAlertOpen(true);
													}
													setSettings((prev) => {
														prev.game.launch = val;
														return { ...prev };
													});
													saveConfigs();
												}}
											>
												<TabsList className="bg-background/50 w-full">
													<TabsTrigger value="0" className="w-1/3 h-10">
														<XIcon className=" rotate-y-180 w-4" />
														{textData._LeftSideBar._components._Settings._AutoReload.Disable}
													</TabsTrigger>
													<TabsTrigger value="1" className="w-1/3 h-10">
														<CheckIcon className=" w-4" /> IMM
													</TabsTrigger>
													<TabsTrigger value="2" className="w-1/3 h-10">
														<Gamepad2Icon className=" w-4" /> {settings.global.game}MI
													</TabsTrigger>
												</TabsList>
											</Tabs>
										</div>
										<div className="flex flex-col w-full gap-4">
											<div className="flex items-center gap-1">
												{textData._LeftSideBar._components._Settings[customMode ? "ModDir" : "XXMIDir"]}
											</div>
											<div className="flex flex-row items-center w-full gap-2">
												<Button
													className="w-1/2"
													onClick={() => {
														setSource("");
														setTarget("");
														setSettingsOpen(false);
														skipPage();
														store.set(INIT_DONE, false);
													}}
												>
													{textData._LeftSideBar._components._Settings.Change}
												</Button>
												<Button className="w-1/2" disabled></Button>
											</div>
										</div>
									</div>
										<div className="min-w-1/2 justify-evenly flex flex-col min-h-full gap-2 pr-2">
											<div className="flex flex-col w-full gap-2">
												{textData._LeftSideBar._components._Settings.ImportExport}
												<div className="flex justify-start w-full gap-2 pr-2">
												<Button
													// disabled={disabled}
													onClick={importConfig}
													className="h-9 w-1/2 text-sm"
												>
													<DownloadIcon className="w-4 h-4" />
													{textData._LeftSideBar._components._Settings._ImportExport.Import}
												</Button>
													<Button onClick={()=>exportConfig(settings,textData)} className="h-9 w-1/2 text-sm">
														<UploadIcon className="w-4 h-4" />
														{textData._LeftSideBar._components._Settings._ImportExport.Export}
													</Button>
												</div>
											</div>
											<div className="flex flex-col w-full gap-2">
												<div className="flex items-center gap-1">Download Queue (Advanced)</div>
												<div className="grid grid-cols-2 gap-2">
													<div className="flex flex-col gap-1">
														<label className="text-xs text-muted-foreground">Downloads</label>
														<Input
															type="number"
															min={1}
															max={3}
															value={settings.game.download.maxConcurrentDownloads}
															onChange={(e) => setDownloadNumber("maxConcurrentDownloads", 1, 3, e.currentTarget.value)}
														/>
													</div>
													<div className="flex flex-col gap-1">
														<label className="text-xs text-muted-foreground">Extracts</label>
														<Input
															type="number"
															min={1}
															max={4}
															value={settings.game.download.maxConcurrentExtracts}
															onChange={(e) => setDownloadNumber("maxConcurrentExtracts", 1, 4, e.currentTarget.value)}
														/>
													</div>
													<div className="flex flex-col gap-1">
														<label className="text-xs text-muted-foreground">Request retries</label>
														<Input
															type="number"
															min={1}
															max={5}
															value={settings.game.download.requestRetries}
															onChange={(e) => setDownloadNumber("requestRetries", 1, 5, e.currentTarget.value)}
														/>
													</div>
													<div className="flex flex-col gap-1">
														<label className="text-xs text-muted-foreground">Requeue rounds</label>
														<Input
															type="number"
															min={1}
															max={8}
															value={settings.game.download.maxRequeueRounds}
															onChange={(e) => setDownloadNumber("maxRequeueRounds", 1, 8, e.currentTarget.value)}
														/>
													</div>
													<div className="flex flex-col gap-1">
														<label className="text-xs text-muted-foreground">Connect timeout (s)</label>
														<Input
															type="number"
															min={3}
															max={60}
															value={settings.game.download.connectTimeoutSec}
															onChange={(e) => setDownloadNumber("connectTimeoutSec", 3, 60, e.currentTarget.value)}
														/>
													</div>
													<div className="flex flex-col gap-1">
														<label className="text-xs text-muted-foreground">Stall timeout (s)</label>
														<Input
															type="number"
															min={5}
															max={180}
															value={settings.game.download.stallTimeoutSec}
															onChange={(e) => setDownloadNumber("stallTimeoutSec", 5, 180, e.currentTarget.value)}
														/>
													</div>
												</div>
											</div>
											<div className="flex items-center gap-1">
												{textData._LeftSideBar._components._Settings.HotKey}
												<Tooltip>
												<TooltipTrigger>
													<InfoIcon className="text-muted-foreground hover:text-gray-300 w-4 h-4" />
												</TooltipTrigger>
												<TooltipContent>
													<div className="flex flex-col gap-1">
														<div>{textData._LeftSideBar._components._Settings._HotKey.HKMsg1}</div>
														<div>
															{textData._LeftSideBar._components._Settings._HotKey.HKMsg2} <b>'IMM'</b>{" "}
															{textData._LeftSideBar._components._Settings._HotKey.HKMsg3}{" "}
															<b>'{textData._LeftSideBar._components._Settings._AutoReload.OnFocus}'</b>
														</div>
														<Separator />
														<div>{textData._LeftSideBar._components._Settings._HotKey.HKMsg4}</div>
														<div>
															{textData._LeftSideBar._components._Settings._HotKey.HKMsg5} <b>Ctrl+C</b>, <b>Alt+Tab</b>
															, {textData._LeftSideBar._components._Settings._HotKey.HKMsg6}
														</div>
														<Separator />
														<div>
															<b>Backspace -</b> {textData._LeftSideBar._components._Settings._HotKey.ClearHK}{" "}
														</div>
													</div>
												</TooltipContent>
											</Tooltip>
										</div>
										<div className="max-h-51 flex flex-col w-full h-full gap-1 p-2 ml-2 overflow-x-hidden overflow-y-auto">
											{presets.length > 0 ? (
												presets.map((preset, index) => (
													<div className="flex flex-col items-center justify-between w-full h-16 gap-2">
														<Input
															className="w-full text-muted-foreground text-ellipsis h-10 p-0 overflow-hidden break-words border-0"
															style={{ backgroundColor: "#0000" }}
															onFocus={(e) => {
																e.currentTarget.blur();
															}}
															value={preset?.name}
														></Input>
														<Input
															defaultValue={formatHotkeyDisplay(preset?.hotkey || "")}
															autoFocus={false}
															contentEditable={false}
															onKeyDownCapture={(e) => {
																e.preventDefault();
																if (e.code == "Backspace") {
																	e.currentTarget.value = "";
																	saveConfigs();
																} else if (e.code == "Escape") {
																	e.currentTarget.value = formatHotkeyDisplay(preset?.hotkey || "");
																	keysdown = [];
																	keys = [];
																} else {
																	let next: any = [];
																	let key = processHotkeyCode(e.code)
																		.split("")
																		.map((x, i) => (i == 0 ? x.toUpperCase() : x))
																		.join("");
																	if (keys.includes(key)) {
																		next = keys;
																	} else {
																		if (!keysdown.includes(e.code)) {
																			keysdown.push(e.code);
																		}
																		keys.push(key);
																		next = keySort(keys);
																	}
																	e.currentTarget.value = next.join(" ﹢ ");
																}
															}}
															onKeyUpCapture={(e) => {
																if (e.code == "Backspace" || e.code == "Escape") return;
																let key = e.code;
																let index = keysdown.indexOf(key);
																if (index > -1) keysdown.splice(index, 1);
																if (keysdown.length == 0) {
																	keys = [];
																	e.currentTarget.blur();
																}
															}}
															onBlur={(e) => {
																keysdown = [];
																keys = [];
																setPresets((prev) => {
																	prev[index].hotkey = encodeHotkeyForStorage(e.currentTarget.value);
																	return [...prev];
																});
																saveConfigs();
																// registerGlobalHotkeys();
															}}
															className="caret-transparent w-full text-center select-none"
															type="text"
														/>
													</div>
												))
											) : (
												<div className="text-white/50 flex items-center justify-center w-full h-full">
													{textData._LeftSideBar._components._Settings._HotKey.HKEmpty}
												</div>
											)}
										</div>
									</div>
								</>
							)}
						</motion.div>
					</AnimatePresence>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

export default Settings;
