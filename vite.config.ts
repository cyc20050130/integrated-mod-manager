import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [
		tailwindcss(),
		react()
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	
	build: {
		sourcemap: !!process.env.TAURI_ENV_DEBUG,
		minify: !process.env.TAURI_ENV_DEBUG,

		rollupOptions: {
			output: {
				
				manualChunks: {
					//'react-vendor': ['react', 'react-dom'],
					'ui-vendor': ['@radix-ui/react-accordion', '@radix-ui/react-alert-dialog', '@radix-ui/react-checkbox'],
					'tauri-vendor': ['@tauri-apps/api', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs', '@tauri-apps/plugin-http'],
					'state-vendor': ['jotai'],
					'motion-vendor': ['motion', 'embla-carousel-react', 'embla-carousel-autoplay']
				},
				
				chunkFileNames: 'assets/js/[name]-[hash].js',
				entryFileNames: 'assets/js/[name]-[hash].js',
				assetFileNames: 'assets/[ext]/[name]-[hash].[ext]'
			}
		},
		chunkSizeWarningLimit: 1000,
	},
	
	clearScreen: false,
	
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
			  }
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**", "**/src-py/**", "**/node_modules/**"],
		},
	},
	
	
	optimizeDeps: {
		include: [
			'react',
			'react-dom',
			'@tauri-apps/api',
			'jotai',
			'motion'
		],
		
		exclude: ['@tauri-apps/cli']
	}
});
