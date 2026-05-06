import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { info } from "@/lib/logger";
import { openFile, saveConfigs, toggleMod, updateIniVars } from "@/utils/filesys";
import { join, setChange } from "@/utils/hotreload";
import { Mod, ModDataObj, ModHotKeys } from "@/utils/types";
import { DATA, MOD_LIST, TEXT_DATA } from "@/utils/vars";
import { PopoverTrigger } from "@radix-ui/react-popover";
import { useAtomValue, useSetAtom } from "jotai";
import {
	ArrowUpRightFromSquareIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	FileIcon,
	InfoIcon,
	IterationCcwIcon,
} from "lucide-react";
import { useState } from "react";

const pageLimit = 20;

type PreferenceValueType = "pref" | "reset" | "name";
type PreferenceValue = string | null;
type PreferenceFileVars = Record<string, Partial<Record<PreferenceValueType, PreferenceValue>>>;
type PreferenceVars = Record<string, PreferenceFileVars>;
type PreferenceKey = ModHotKeys & { state?: string | null };
type PreferenceGroup = { file: string; keys: PreferenceKey[] };
type PreferenceDetails = {
	keys?: PreferenceKey[];
	files?: Record<string, PreferenceKey[]>;
};
type PreferenceItem = Pick<Mod, "path" | "enabled">;

function paginateKeys(fileData: PreferenceKey[]): PreferenceKey[][] {
	const paginatedData: PreferenceKey[][] = [];
	for (let i = 0; i < fileData.length; i += pageLimit) {
		paginatedData.push(fileData.slice(i, i + pageLimit));
	}
	return paginatedData;
}

function buildPreferenceGroups(source: PreferenceKey[]): { groups: PreferenceGroup[]; signature: string } {
	const groupsByFile: Record<string, PreferenceKey[]> = {};
	const keyListStr: string[] = [];

	source.forEach((keyConfig) => {
		if (!keyConfig.default) {
			return;
		}
		if (!groupsByFile[keyConfig.file]) {
			groupsByFile[keyConfig.file] = [];
		}
		groupsByFile[keyConfig.file].push(keyConfig);
		keyListStr.push(`${keyConfig.file}|${keyConfig.target}`);
	});

	return {
		groups: Object.keys(groupsByFile).map((file) => ({
			file,
			keys: groupsByFile[file],
		})),
		signature: keyListStr.join(","),
	};
}

function ModPreferences({ item, details }: { item: PreferenceItem; details: PreferenceDetails }) {
	const setData = useSetAtom(DATA);
	const setModList = useSetAtom(MOD_LIST);
	const [fileMode, setFileMode] = useState(false);
	const [selectedFileState, setSelectedFileState] = useState("");
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [pageNoState, setPageNoState] = useState(0);
	const textData = useAtomValue(TEXT_DATA);

	const availableFiles = Object.keys(details.files ?? {});
	const selectedFile =
		availableFiles.length === 1 && !selectedFileState
			? availableFiles[0]
			: availableFiles.includes(selectedFileState)
				? selectedFileState
				: "";
	const selectedFilePages = selectedFile ? paginateKeys(details.files?.[selectedFile] ?? []) : [];
	const totalPages = selectedFile
		? Math.max(1, Math.ceil((details.files?.[selectedFile]?.length ?? 0) / pageLimit))
		: 1;
	const pageNo = Math.min(pageNoState, totalPages - 1);
	const source = fileMode ? selectedFilePages[pageNo] ?? [] : (details.keys ?? []);
	const { groups: keys, signature: keyListSignature } = buildPreferenceGroups(source);

	async function refreshMod(path: string) {
		await toggleMod(path, true, true);
		setChange();
	}

	function setVal(type: PreferenceValueType, file: string, target: string, value: PreferenceValue) {
		setData((prev) => {
			const nextData: ModDataObj = { ...(prev ?? {}) };
			const currentItem = { ...(nextData[item.path] ?? {}) };
			const currentVars: PreferenceVars = { ...((currentItem.vars as PreferenceVars | undefined) ?? {}) };
			const fileVars: PreferenceFileVars = { ...(currentVars[file] ?? {}) };
			const targetVars = { ...(fileVars[target] ?? {}) };

			if (value) {
				targetVars[type] = value;
				fileVars[target] = targetVars;
				currentVars[file] = fileVars;
				currentItem.vars = currentVars;
				nextData[item.path] = currentItem;
			} else {
				delete targetVars[type];
				if (Object.keys(targetVars).length > 0) {
					fileVars[target] = targetVars;
				} else {
					delete fileVars[target];
				}

				if (Object.keys(fileVars).length > 0) {
					currentVars[file] = fileVars;
				} else {
					delete currentVars[file];
				}

				if (Object.keys(currentVars).length > 0) {
					currentItem.vars = currentVars;
					nextData[item.path] = currentItem;
				} else {
					delete currentItem.vars;
					if (Object.keys(currentItem).length > 0) {
						nextData[item.path] = currentItem;
					} else {
						delete nextData[item.path];
					}
				}
			}

			return nextData;
		});
		saveConfigs();
		if (item.enabled) {
			void refreshMod(item.path);
		}
	}

	return (
		<DialogContent className="min-w-250">
			<Tooltip>
				<TooltipTrigger />
				<TooltipContent className="opacity-0" />
			</Tooltip>

			<div className="min-h-fit text-accent my-6 text-3xl">
				{" "}
				{textData._RightSideBar._components._ModPreferences.EditConfig}
			</div>

			<div className="text-sm flex items-center gap-2">
				<Checkbox checked={fileMode} onCheckedChange={(checked) => setFileMode(Boolean(checked))} />{" "}
				{textData._RightSideBar._components._ModPreferences.ShowVars}
			</div>
			<div
				style={{
					opacity: fileMode ? 1 : 0,
					pointerEvents: fileMode ? "auto" : "none",
					userSelect: fileMode ? "auto" : "none",
					minHeight: fileMode ? "2.75rem" : 0,
					marginBottom: fileMode ? 0 : "-1.5rem",
					marginTop: fileMode ? 0 : "-1.5rem",
				}}
				className="flex items-center duration-300 overflow-hidden w-full gap-2"
			>
				<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
					<PopoverTrigger>
						<div className="min-w-179 button-like zzz-border w-full hover:brightness-150 bg-sidebar cursor-pointerx flex items-center justify-center h-full gap-1 p-2 text-xs duration-300 rounded-md select-none">
							{selectedFile ? (
								<>
									<FileIcon className="w-3 h-3" />
									{selectedFile}
								</>
							) : (
								textData._RightSideBar._components._ModPreferences.Select
							)}
						</div>
					</PopoverTrigger>
					<PopoverContent
						className="p-0 max-h-100 min-w-175 overflow-y-scroll scroll-auto z-100 pointer-events-auto"
						onWheel={(e) => {
							e.currentTarget.scrollBy({
								top: e.deltaY,
							});
						}}
					>
						{availableFiles.map((file) => (
							<div
								key={file}
								className="cursor-pointer hover:bg-background/50 px-4 py-2 text-sm"
								onClick={() => {
									setSelectedFileState(file);
									setPageNoState(0);
									setPopoverOpen(false);
								}}
							>
								{file}
							</div>
						))}
					</PopoverContent>
				</Popover>
				<div className="flex w-full gap-2">
					<Button
						onClick={() => {
							setPageNoState((prev) => Math.max(prev - 1, 0));
						}}
					>
						<ChevronLeftIcon className="w-3 h-3" />
					</Button>
					<div className="text-sm text-muted-foreground flex items-center justify-center min-w-fit">
						{textData._RightSideBar._components._ModPreferences.Page}
						<Input
							key={pageNo}
							defaultValue={pageNo + 1}
							onBlur={(e) => {
								const val = Number(e.currentTarget.value);
								if (isNaN(val) || val < 1 || val > totalPages) {
									e.currentTarget.value = String(pageNo + 1);
									return;
								}
								setPageNoState(val - 1);
							}}
							className="text-center w-12 mx-2 p-1"
						/>
						{textData._RightSideBar._components._ModPreferences.Of} {totalPages}
					</div>
					<Button
						onClick={() => {
							setPageNoState((prev) => Math.min(prev + 1, totalPages - 1));
						}}
					>
						<ChevronRightIcon className="w-3 h-3" />
					</Button>
				</div>
			</div>
			<div className="bg-background/80 button-like text-border backdrop-blur border-muted/20 sticky top-0 z-10 flex w-full px-8 py-2 border rounded-md">
				<Tooltip>
					<TooltipTrigger className="text-accent flex items-center justify-center w-full gap-2 mr-2 -ml-2">
						<InfoIcon className="text-accent/70 cursor-help inline-block w-4 h-4 ml-1" />
						{textData._RightSideBar._components._ModPreferences.Name}
					</TooltipTrigger>
					<TooltipContent className="w-48 px-1 text-center">
						{textData._RightSideBar._components._ModPreferences.NameTip}
					</TooltipContent>
				</Tooltip>
				|{/* <div className="text-accent w-1/5 text-center">Target Var</div>| */}
				<Tooltip>
					<TooltipTrigger className="text-accent flex items-center justify-center w-full gap-2">
						<InfoIcon className="text-accent/70 cursor-help inline-block w-4 h-4 ml-1" />
						{textData._RightSideBar._components._ModPreferences.DefVal}
					</TooltipTrigger>
					<TooltipContent className="w-48 px-1 text-center">
						{textData._RightSideBar._components._ModPreferences.DefValTip}
					</TooltipContent>
				</Tooltip>
				|
				<Tooltip>
					<TooltipTrigger className="text-accent flex items-center justify-center w-full gap-2">
						<InfoIcon className="text-accent/70 cursor-help inline-block w-4 h-4 ml-1" />
						{textData._RightSideBar._components._ModPreferences.Pref}
					</TooltipTrigger>
					<TooltipContent className="w-48 px-1 text-center">
						{textData._RightSideBar._components._ModPreferences.PrefTip}
					</TooltipContent>
				</Tooltip>
				|
				<Tooltip>
					<TooltipTrigger className="text-accent flex items-center justify-center w-full gap-2 -mr-4">
						{textData._RightSideBar._components._ModPreferences.Expected}
					</TooltipTrigger>
				</Tooltip>
			</div>
			<label className="text-xs text-accent/50 -my-3">
				{textData._RightSideBar._components._ModPreferences.Priority}
			</label>
			<div
				className="max-h-90 min-h-90 flex flex-col w-full h-full p-2 pt-0 overflow-x-hidden overflow-y-scroll text-gray-300 rounded-sm"
				key={`${fileMode}-${pageNo}-${selectedFile}-${keys.length}-${keyListSignature}`}
			>
				{keys.map((file, index) => (
					<div
						key={file.file}
						className="min-h-fit flex flex-col w-full px-4 py-2 mt-2 border rounded-md"
						style={{
							marginTop: index === 0 ? "0px" : "",
						}}
					>
						<div className="text-accent flex items-center gap-1 mb-2 text-sm">
							<Button
								className="aspect-square mt-0.5 max-h-5 max-w-5"
								onClick={() => {
									openFile(join(item.path, file.file));
								}}
							>
								<ArrowUpRightFromSquareIcon className="max-h-3" />
							</Button>
							{file.file}
						</div>
						{file.keys.map((keyConfig, index) => {
							const nameDefault = keyConfig.name === keyConfig.target;
							const defDefault = keyConfig.reset === null || keyConfig.reset === undefined;
							const prefDefault = keyConfig.pref === null || keyConfig.pref === undefined;
							return (
								<div
									key={`${keyConfig.file}-${keyConfig.target}-${index}`}
									className="odd:bg-background/50 even:bg-background/30 text-border flex w-full gap-4 px-5 py-2 rounded-md"
								>
									<div className="w-full min-w-[24.5%] flex items-center">
										<Input
											className="text-muted-foreground w-full bg-transparent text-ellipsis -mr-8.5"
											defaultValue={keyConfig.name}
											style={{
												paddingRight: nameDefault ? "" : "2rem",
											}}
											onBlur={(e) => {
												const val = e.currentTarget.value;
												if (val === keyConfig.name || (!val && !keyConfig.name)) {
													return;
												}
												if (val === keyConfig.target) {
													setVal("name", keyConfig.file, keyConfig.target, null);
													return;
												}
												setVal("name", keyConfig.file, keyConfig.target, val);
											}}
										/>

										<Button
											variant="ghost"
											className=" h-7 w-7 ml-0.75"
											style={{
												pointerEvents: nameDefault ? "none" : "auto",
												opacity: nameDefault ? 0 : 1,
											}}
											onClick={(e) => {
												const prev = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (prev) {
													prev.focus();
													prev.value = keyConfig.target;
													prev.blur();
												}
											}}
										>
											<IterationCcwIcon className="max-h-4 rotate-180" />
										</Button>
									</div>
									<div className="w-full min-w-[24.5%] flex items-center">
										<Input
											className="text-muted-foreground w-full bg-transparent -mr-8.5"
											style={{
												textAlign: isNaN(Number(keyConfig.default)) ? "left" : "right",
												paddingRight: defDefault ? "" : "2rem",
											}}
											defaultValue={keyConfig.default}
											onBlur={(e) => {
												const val = e.currentTarget.value;
												if (val === keyConfig.default || (!val && !keyConfig.default)) {
													return;
												}
												if (!val) {
													e.currentTarget.value = keyConfig.default;
													return;
												}
												if (keyConfig.reset === null || keyConfig.reset === undefined) {
													setVal("reset", keyConfig.file, keyConfig.target, keyConfig.default);
												} else if (val === keyConfig.reset) {
													setVal("reset", keyConfig.file, keyConfig.target, null);
												}
												info("Updating ini", {
													src: join(item.path, keyConfig.file),
													target: keyConfig.target,
													content: val,
												});
												updateIniVars(join(item.path, keyConfig.file), {
													[keyConfig.target.toLowerCase()]: val,
												}).then((success) => {
													if (success) {
														setModList((prev) =>
															prev.map((mod) => {
																if (mod.path !== item.path) {
																	return mod;
																}
																return {
																	...mod,
																	keys: mod.keys.map((k) =>
																		k.file === keyConfig.file && k.target === keyConfig.target
																			? { ...k, default: val }
																			: k
																	),
																};
															})
														);
													}
												});
											}}
										/>
										<Button
											variant="ghost"
											className=" h-7 w-7 ml-0.75"
											style={{
												pointerEvents: defDefault ? "none" : "auto",
												opacity: defDefault ? 0 : 1,
											}}
											onClick={(e) => {
												const prev = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (prev) {
													prev.focus();
													prev.value = keyConfig.reset ?? "";
													prev.blur();
												}
											}}
										>
											<IterationCcwIcon className="max-h-4 rotate-180" />
										</Button>
									</div>
									<div className="w-full min-w-[24.5%] flex items-center">
										<Input
											className="text-muted-foreground w-full bg-transparent duration-200 -mr-8.5"
											style={{
												textAlign: isNaN(Number(keyConfig.pref ?? keyConfig.default)) ? "left" : "right",
												paddingRight: prefDefault ? "" : "2rem",
											}}
											defaultValue={keyConfig.pref ?? ""}
											onBlur={(e) => {
												const val = e.currentTarget.value;
												if (val === keyConfig.pref || (!val && !keyConfig.pref)) {
													return;
												}
												setVal("pref", keyConfig.namespace ? "namespace" : keyConfig.file, keyConfig.target, val);
											}}
											placeholder={
												keyConfig.state
													? `${textData._RightSideBar._components._ModPreferences.AutoSaved} ${keyConfig.state}`
													: textData._RightSideBar._components._ModPreferences.Default
											}
										/>

										<Button
											variant="ghost"
											className=" h-7 w-7 ml-0.75"
											style={{
												pointerEvents: prefDefault ? "none" : "auto",
												opacity: prefDefault ? 0 : 1,
											}}
											onClick={(e) => {
												const prev = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (prev) {
													prev.focus();
													prev.value = "";
													prev.blur();
												}
											}}
										>
											<IterationCcwIcon className="max-h-4 rotate-180" />
										</Button>
									</div>
									<div className="text-muted-foreground flex items-center justify-center w-full min-w-[24.5%]">
										{([...(keyConfig.values || [])].sort().join(" , ") || "unknown").replace(
											"unknown",
											textData._RightSideBar._components._ModPreferences.Unknown
										)}
									</div>
								</div>
							);
						})}
					</div>
				))}
			</div>
		</DialogContent>
	);
}

export default ModPreferences;
