import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { savePreviewImageFromData } from "@/utils/filesys";
import { Mod } from "@/utils/types";
import { UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
function ModPreview({
	item,
	setDialogType,
	isBlank: _isBlank,
}: {
	item: Mod;
	setDialogType: (type: string) => void;
	isBlank: boolean;
}) {
	const onDrop = useCallback(
		async (acceptedFiles: File[]) => {
			if (acceptedFiles.length === 0) return;
			const file = acceptedFiles[0];
			const extension = file.type.split("/").pop() || "png";
			// Read file as ArrayBuffer and convert to Uint8Array
			const arrayBuffer = await file.arrayBuffer();
			const data = new Uint8Array(arrayBuffer);
			await savePreviewImageFromData(item.path, extension, data);
			setDialogType("preview-crop");
		},
		[item.path, setDialogType]
	);

	const inputRef = useRef<HTMLInputElement>(null);

	const { getRootProps, getInputProps, isDragActive } = useDropzone({
		onDrop,
		multiple: false,
		accept: {
			"image/png": [".png"],
			"image/jpeg": [".jpg", ".jpeg"],
			"image/gif": [".gif"],
			"image/webp": [".webp"],
		},
		noClick: true,
	});
	useEffect(() => {
		function handlePaste(event: ClipboardEvent) {
			const items = event.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) {
						onDrop([file]);
						event.preventDefault();
						break;
					}
				}
			}
		}
		document.addEventListener("paste", handlePaste);
		return () => {
			document.removeEventListener("paste", handlePaste);
		};
	}, [onDrop]);

	return (
		<DialogContent className=" select-none min-w-136 min-h-0">
			<Tooltip>
				<TooltipTrigger asChild>
					<span aria-hidden="true" />
				</TooltipTrigger>
				<TooltipContent className="opacity-0"></TooltipContent>
			</Tooltip>

			<div className="min-h-fit text-accent mb-4 text-3xl">Set Preview Image</div>

			<div
				{...getRootProps({
					className: `h-64 w-128 border-[1.5px] border-dashed rounded items-center justify-center flex flex-col transition-colors ${
						isDragActive ? "border-accent bg-accent/10" : "border-accent/30"
					}`,
				})}
			>
				<input {...getInputProps()} ref={inputRef} />
				{isDragActive ? (
					<p className="text-accent">Drop the image here...</p>
				) : (
					<div className="w-full h-full flex items-center justify-center text-accent/50">
						<div className="w-1/2 h-full flex flex-col items-center justify-center text-sm gap-4">
							<Button
								className="min-w-36"
								onClick={(e) => {
									e.stopPropagation();
									inputRef.current?.click();
								}}
								type="button"
							>
								Select File
							</Button>
							<label className="text-xs text-gray-400">OR</label>
							<label className="text-accent">Paste Image from clipboard</label>
						</div>
						<div className="w-1/2 border-l h-full flex flex-col gap-2 items-center justify-center">
							<UploadIcon className="w-6 h-6" />
							<label className="text-sm text-accent text-center">Drag and Drop Here</label>
						</div>
					</div>
				)}
			</div>
		</DialogContent>
	);
}

export default ModPreview;
