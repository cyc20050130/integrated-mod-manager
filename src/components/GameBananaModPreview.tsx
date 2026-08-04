import { useEffect, useMemo, useState, type CSSProperties, type ImgHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import {
	invalidateGameBananaModPreview,
	resolveGameBananaModPreview,
	type GameBananaModPreviewAsset,
} from "@/utils/remoteMedia";
import { normalizeGameBananaTopSubImage, type GameBananaPreviewResolution } from "@/utils/gameBananaPreview";

type PreviewState =
	| { key: string; kind: "loading" }
	| { key: string; kind: "ready"; asset: GameBananaModPreviewAsset & { assetUrl: string } }
	| { key: string; kind: "error"; reason: string };

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "style"> & {
	source?: string | null;
	resolution?: GameBananaPreviewResolution;
	className?: string;
	style?: CSSProperties;
	alt?: string;
};

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function isRetryableError(error: unknown): boolean {
	if (isAbortError(error)) return false;
	const message = String(error || "");
	return !/invalid_|allowlist|validation|malformed|decode|body_limit|unsupported|4\d\d/i.test(message);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			window.clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(new DOMException("The request was aborted", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function fallbackImage(className: string, style: CSSProperties | undefined, alt: string) {
	return <img className={className} style={style} src="/who.jpg" alt={alt} aria-label={alt} />;
}

export function GameBananaModPreview({
	source,
	resolution,
	className = "",
	style,
	alt = "Mod preview",
	...props
}: Props) {
	const computedResolution: GameBananaPreviewResolution = useMemo(
		() => normalizeGameBananaTopSubImage(source || ""),
		[source]
	);
	const normalized = resolution || computedResolution;
	const normalizedSource = normalized.kind === "ready" ? normalized.url : "";
	const [retryGeneration, setRetryGeneration] = useState(0);
	const requestKey = `${normalizedSource}\u0000${retryGeneration}`;
	const [state, setState] = useState<PreviewState | null>(null);

	useEffect(() => {
		if (normalized.kind !== "ready") return;
		const controller = new AbortController();
		let disposed = false;

		const run = async () => {
			let lastError: unknown = new Error("preview_request_failed");
			for (let attempt = 1; attempt <= 3; attempt += 1) {
				try {
					const asset = await resolveGameBananaModPreview(normalizedSource, controller.signal);
					if (!disposed) setState({ key: requestKey, kind: "ready", asset });
					return;
				} catch (error) {
					lastError = error;
					if (disposed || controller.signal.aborted || isAbortError(error)) return;
					if (attempt >= 3 || !isRetryableError(error)) break;
					try {
						await wait(attempt === 1 ? 250 : 750, controller.signal);
					} catch {
						return;
					}
				}
			}
			if (!disposed)
				setState({ key: requestKey, kind: "error", reason: String(lastError || "preview_request_failed") });
		};
		void run();
		return () => {
			disposed = true;
			controller.abort();
		};
	}, [normalized.kind, normalizedSource, requestKey]);

	if (normalized.kind === "missing") return fallbackImage(className, style, alt);
	if (normalized.kind === "error") {
		return (
			<div
				className={`${className} relative flex items-center justify-center bg-background/30 text-xs text-muted-foreground`}
				style={style}
				role="img"
				aria-label={alt}
			>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="pointer-events-auto"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						setRetryGeneration((value) => value + 1);
					}}
				>
					重试预览
				</Button>
			</div>
		);
	}
	if (state?.key !== requestKey || state.kind === "loading" || !state) {
		return (
			<div
				className={`${className} animate-pulse bg-background/30`}
				style={style}
				role="img"
				aria-label={`${alt}加载中`}
			/>
		);
	}
	if (state.kind === "error") {
		return (
			<div
				className={`${className} relative flex items-center justify-center bg-background/30 text-xs text-muted-foreground`}
				style={style}
				role="img"
				aria-label={`${alt}加载失败`}
			>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="pointer-events-auto"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						setRetryGeneration((value) => value + 1);
					}}
				>
					重试预览
				</Button>
			</div>
		);
	}

	return (
		<img
			{...props}
			className={className}
			style={style}
			src={`${state.asset.assetUrl}&view=${encodeURIComponent(requestKey)}`}
			alt={alt}
			onError={() => {
				void invalidateGameBananaModPreview(normalizedSource)
					.catch(() => undefined)
					.finally(() => setRetryGeneration((value) => value + 1));
			}}
		/>
	);
}
