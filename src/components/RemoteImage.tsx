import { resolveRemoteMediaUrl, isRemoteMediaSource } from "@/utils/remoteMedia";
import { useEffect, useState, type ImgHTMLAttributes } from "react";

type RemoteImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	src?: string | null | undefined;
	fallbackSrc?: string;
};

export function RemoteImage({ src, fallbackSrc = "/who.jpg", onError, ...props }: RemoteImageProps) {
	const source = src || "";
	const remote = isRemoteMediaSource(source);
	const requestKey = `${source}\u0000${fallbackSrc}`;
	const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null);
	const resolvedSource =
		remote && resolved?.key === requestKey ? resolved.url : remote ? fallbackSrc : source || fallbackSrc;

	useEffect(() => {
		let cancelled = false;
		if (!remote) return;
		resolveRemoteMediaUrl(source)
			.then((url) => {
				if (!cancelled) setResolved({ key: requestKey, url });
			})
			.catch(() => {
				if (!cancelled) setResolved({ key: requestKey, url: fallbackSrc });
			});
		return () => {
			cancelled = true;
		};
	}, [fallbackSrc, remote, requestKey, source]);

	return (
		<img
			{...props}
			src={resolvedSource}
			onError={(event) => {
				if (remote && resolvedSource !== fallbackSrc) {
					setResolved({ key: requestKey, url: fallbackSrc });
				}
				onError?.(event);
			}}
		/>
	);
}
