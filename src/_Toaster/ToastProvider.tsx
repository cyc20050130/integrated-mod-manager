import { store, TOASTS } from "@/utils/vars";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
// import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
let counter = 0;
export function addToast({
	id = Date.now(),
	type = "info",
	message,
	duration = 3000,
	onClick = null,
}: {
	id?: number;
	type?: "success" | "error" | "info" | "warning";
	message: string;
	duration?: number;
	onClick?: null | (() => void);
}) {
	const toast = { id, type, message, onClick };
	counter++;
	setTimeout(() => {
		store.set(TOASTS, (prevToasts) => prevToasts.filter((t) => t.id !== toast.id));
	}, duration);
	store.set(TOASTS, (prevToasts) => [...prevToasts, toast].slice(-3));
}
function ToastProvider() {
	const toasts = useAtomValue(TOASTS);
	return createPortal(
		<>
			<div className="fixed z-99999 top-5 left-1/2 -translate-x-1/2 w-82 h-2 flex flex-col-reverse items-center justify-center pointer-events-none">
				<AnimatePresence>
					{toasts.map((toast: any, index: number) => (
						<motion.div
							key={toast.id}
							initial={{ opacity: 0, y: -20 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -20 }}
							transition={{ duration: 0.3 }}
							layout
							style={{
								zIndex: 99999 - counter + index,
								scale: 0.9 + (index - toasts.length) * 0.1,
								color:
									toast.type === "success"
										? "var(--success)"
										: toast.type === "error"
											? "var(--destructive)"
											: toast.type === "warning"
												? "var(--warn)"
												: "",
								pointerEvents: toast.onClick ? "auto" : "none",
							}}
							className="data-wuwa:px-1 game-font bgpattern min-h-20 -mb-22 bg-card data-gi:outline button-like flex items-center justify-center w-full h-20 px-4 py-1 text-center border rounded-md pointer-events-none"
							onClick={toast.onClick || undefined}
						>
							<p className="text-sm">
								{toast.message}
								</p>
						</motion.div>
					))}
				</AnimatePresence>
			</div>
		</>,
		document.body
	);
}

export default ToastProvider;
