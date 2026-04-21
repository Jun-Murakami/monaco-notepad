import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	test: {
		environment: 'node',
		globals: false,
		setupFiles: ['./vitest.setup.ts'],
		include: ['src/**/__tests__/**/*.test.ts'],
		coverage: {
			include: ['src/services/**/*.ts'],
			exclude: ['src/services/**/__tests__/**'],
			reporter: ['text', 'html'],
		},
	},
});
