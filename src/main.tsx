import ReactDOM from "react-dom/client";
import { store } from "./utils/vars";
import { ThemeProvider } from "./components/theme-provide";
import { Provider } from "jotai";
import App from "./App";
import ErrorBoundary from "./utils/errorCatcher";
import Decorations from "./utils/decorations";
import { invoke } from "@tauri-apps/api/core";

window.addEventListener("keydown", (e) => {
	if (e.key === "F8") {
		e.preventDefault();
		invoke("open_logs_folder");
	}
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<Provider store={store}>
		<ThemeProvider defaultTheme="dark">
			<ErrorBoundary>
				<Decorations />
				<App />
			</ErrorBoundary>
		</ThemeProvider>
	</Provider>
);
