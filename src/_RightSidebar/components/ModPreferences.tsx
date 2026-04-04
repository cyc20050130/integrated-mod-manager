import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openFile, saveConfigs, toggleMod, updateIniVars } from "@/utils/filesys";
import { join, setChange } from "@/utils/hotreload";
import { ModHotKeys } from "@/utils/types";

import { DATA, MOD_LIST, TEXT_DATA } from "@/utils/vars";

import { useAtomValue, useSetAtom } from "jotai";
import {
	ArrowUpRightFromSquareIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	FileIcon,
	InfoIcon,
	IterationCcwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { info } from "@/lib/logger";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { PopoverTrigger } from "@radix-ui/react-popover";
let prevItemPath = "";
const pageLimit = 20;
let lastKeyList: string = "";
function ModPreferences({ item, details }: { item: any; details: any }) {
	const setData = useSetAtom(DATA);
	const setModList = useSetAtom(MOD_LIST);
	const [keys, setKeys] = useState([] as any);
	const [fileMode, setFileMode] = useState(false);
	const [selectedFile, setSelectedFile] = useState("");
	const [selectedFileData, setSelectedFileData] = useState([] as any);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [pageNo, setPageNo] = useState(0);
	const textData = useAtomValue(TEXT_DATA);
	const [forceKeyUpdate, setForceKeyUpdate] = useState(0);
	useEffect(() => {
		if (prevItemPath !== item?.path || (!details?.files?.hasOwnProperty(selectedFile) && selectedFile)) {
			setSelectedFile("");
			setPageNo(0);
			prevItemPath = item?.path;
		}
	}, [item, details, selectedFile]);
	useEffect(() => {
		setPageNo(0);
		setSelectedFileData([] as any);
	}, [selectedFile]);
	useEffect(() => {
		// console.log(pageNo, selectedFileData[pageNo]);
		let source = (fileMode ? (selectedFileData.length && selectedFileData[pageNo]) || [] : details?.keys) || [];
		const k = {} as any;
		let keyListStr = [] as any;
		source.forEach((keyConfig: ModHotKeys) => {
			if (!keyConfig.default) return;
			if (!k[keyConfig.file]) {
				k[keyConfig.file] = [];
			}
			k[keyConfig.file].push(keyConfig);
			keyListStr.push(`${keyConfig.file}|${keyConfig.target}`);
		});
		setKeys(
			Object.keys(k).map((key) => {
				return { file: key, keys: k[key] };
			})
		);
		keyListStr = keyListStr.join(",");
		if (lastKeyList !== keyListStr) {
			setForceKeyUpdate((prev) => prev + 1);
		}
		lastKeyList = keyListStr;
	}, [details, fileMode, selectedFileData, pageNo]);
	useEffect(() => {
		if (!selectedFile && details?.files && Object.keys(details.files).length == 1) {
			const onlyFile = Object.keys(details.files)[0];
			setSelectedFile(onlyFile);
			return;
		}
		if (fileMode && details?.files && details.files[selectedFile]) {
			const fileData = details.files[selectedFile] || [];
			const pagenatedData = [] as any;
			for (let i = 0; i < fileData.length; i += pageLimit) {
				pagenatedData.push(fileData.slice(i, i + pageLimit));
			}
			setSelectedFileData(pagenatedData);
		}
	}, [details, fileMode, selectedFile]);
	console.log(item);
	async function refreshMod(path: string) {
		await toggleMod(path, true, true);
		setChange();
	}
	const setVal = useCallback(
		(type = "pref" as "pref" | "reset" | "name", file: string, target: string, value: any) => {
			setData((prev: any) => {
				prev = prev || {};
				prev[item.path] = prev[item.path] || {};
				prev[item.path].vars = prev[item.path].vars || {};
				prev[item.path].vars[file] = prev[item.path].vars[file] || {};
				prev[item.path].vars[file][target] = prev[item.path].vars[file][target] || {};
				prev[item.path].vars[file][target][type] = value;
				if (!value) {
					delete prev[item.path].vars[file][target][type];
					if (Object.keys(prev[item.path].vars[file][target]).length === 0) {
						delete prev[item.path].vars[file][target];
						if (Object.keys(prev[item.path].vars[file]).length === 0) {
							delete prev[item.path].vars[file];
							if (Object.keys(prev[item.path].vars).length === 0) {
								delete prev[item.path].vars;
								if (Object.keys(prev[item.path]).length === 0) {
									delete prev[item.path];
								}
							}
						}
					}
				}
				return {
					...prev,
				};
			});
			saveConfigs();
			if (item?.enabled) {
				refreshMod(item.path);
			}
		},
		[item, setData]
	);
	return (
		<DialogContent className="min-w-250">
			<Tooltip>
				<TooltipTrigger></TooltipTrigger>
				<TooltipContent className="opacity-0"></TooltipContent>
			</Tooltip>

			<div className="min-h-fit text-accent my-6 text-3xl">
				{" "}
				{textData._RightSideBar._components._ModPreferences.EditConfig}
			</div>

			<div className="text-sm flex items-center gap-2">
				<Checkbox checked={fileMode} onCheckedChange={(checked) => setFileMode(!!checked)} />{" "}
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
				<Popover
					open={popoverOpen}
					onOpenChange={(open) => {
						setPopoverOpen(open);
					}}
				>
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
						{details?.files &&
							Object.keys(details.files).map((file: string, index: number) => (
								<div
									key={index}
									className="cursor-pointer hover:bg-background/50 px-4 py-2 text-sm"
									onClick={() => {
										setSelectedFile(file);
										const fileData = details.files[file] || [];
										const pagenatedData = [] as any;
										for (let i = 0; i < fileData.length; i += pageLimit) {
											pagenatedData.push(fileData.slice(i, i + pageLimit));
										}
										setSelectedFileData(pagenatedData);
										setPageNo(0);
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
							setPageNo((prev) => Math.max(prev - 1, 0));
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
								if (isNaN(val) || val - 1 >= details.files[selectedFile]?.length / pageLimit) {
									e.currentTarget.value = String(pageNo + 1);
									return;
								}
								setPageNo(val - 1);
							}}
							className="text-center w-12 mx-2 p-1"
						/>
						{textData._RightSideBar._components._ModPreferences.Of}{" "}
						{details.files[selectedFile]?.length ? Math.ceil(details.files[selectedFile].length / pageLimit) : 1}
					</div>
					<Button
						onClick={() => {
							setPageNo((prev) =>
								Math.min(
									prev + 1,
									details.files[selectedFile]?.length
										? Math.ceil(details.files[selectedFile].length / pageLimit) - 1
										: 0
								)
							);
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
						{/* <InfoIcon className="text-accent/70 cursor-help inline-block w-4 h-4 ml-1" /> */}
						{textData._RightSideBar._components._ModPreferences.Expected}
					</TooltipTrigger>
					{/* <TooltipContent className="w-48 px-1 text-center">
							{
								"Shows the current key-binding for this variable. Future versions of IMM may allow changing key-bindings here."
							}
						</TooltipContent> */}
				</Tooltip>
			</div>
			<label className="text-xs text-accent/50 -my-3">
				{textData._RightSideBar._components._ModPreferences.Priority}
			</label>
			<div
				className="max-h-90 min-h-90 flex flex-col w-full h-full p-2 pt-0 overflow-x-hidden overflow-y-scroll text-gray-300 rounded-sm"
				key={"" + fileMode + pageNo + selectedFile + keys.length + forceKeyUpdate}
			>
				{keys.map((file: any, index: number) => (
					<div
						key={index}
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
						{file.keys.map((keyConfig: any, index: number) => {
							const nameDefault = keyConfig.name == keyConfig.target;
							const defDefault = keyConfig.reset === null || keyConfig.reset === undefined;
							const prefDefault = keyConfig.pref === null || keyConfig.pref === undefined;
							return (
								<div
									key={index}
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
												if (val == keyConfig.name || (!val && !keyConfig.name)) {
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
												if (val == keyConfig.default || (!val && !keyConfig.default)) {
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
														setModList((prev: any) => {
															const newList = prev.map((mod: any) => {
																if (mod.path === item.path) {
																	mod.keys = mod.keys.map((k: any) => {
																		if (k.file === keyConfig.file && k.target === keyConfig.target) {
																			k.default = val;
																		}
																		return k;
																	});
																	return {
																		...mod,
																	};
																}
																return mod;
															});
															return newList;
														});
													} else {
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
													prev.value = keyConfig.reset;
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
											defaultValue={keyConfig.pref}
											onBlur={(e) => {
												const val = e.currentTarget.value;
												if (val == keyConfig.pref || (!val && !keyConfig.pref)) {
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
										{(keyConfig.values.toSorted().join(" , ") || "unknown").replace(
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
