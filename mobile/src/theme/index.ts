import { MD3DarkTheme, MD3LightTheme } from 'react-native-paper';

/**
 * デスクトップ版 frontend/src/lib/theme.ts の cyan ベースのパレットに揃えたテーマ。
 * Paper の MD3 theme をベースに、accent カラーと背景色だけ上書きする。
 */

// デスクトップ版と同じ primary
const LIGHT_PRIMARY = '#00c1d9';
const DARK_PRIMARY = '#01afc6';

export const lightTheme = {
	...MD3LightTheme,
	colors: {
		...MD3LightTheme.colors,

		primary: LIGHT_PRIMARY,
		onPrimary: '#ffffff',
		primaryContainer: '#a5eff8',
		onPrimaryContainer: '#001f25',

		secondary: '#475f67',
		onSecondary: '#ffffff',
		secondaryContainer: '#cbe6ef',
		onSecondaryContainer: '#001f27',

		tertiary: '#505e7d',
		onTertiary: '#ffffff',
		tertiaryContainer: '#d8e2ff',
		onTertiaryContainer: '#0a1b37',

		error: '#d91900',
		onError: '#ffffff',
		errorContainer: '#ffdad4',
		onErrorContainer: '#410001',

		background: '#ffffff',
		onBackground: '#1a1c1e',
		surface: '#ffffff',
		onSurface: '#1a1c1e',
		// カード背景はデスクトップ版と同等の濃度（#e3e7eb 前後）を意図
		surfaceVariant: '#dfe3e8',
		onSurfaceVariant: '#444649',

		// Divider / 細罫用
		outline: '#a6abb0',
		outlineVariant: '#c3c8cd',

		elevation: {
			...MD3LightTheme.colors.elevation,
			level1: '#eef1f4',
			level2: '#e4e8ec',
			level3: '#dde2e7',
		},
	},
};

export const darkTheme = {
	...MD3DarkTheme,
	colors: {
		...MD3DarkTheme.colors,

		primary: DARK_PRIMARY,
		onPrimary: '#00363e',
		primaryContainer: '#004f5b',
		onPrimaryContainer: '#76f2ff',

		secondary: '#b1cbd3',
		onSecondary: '#1b343c',
		secondaryContainer: '#334b53',
		onSecondaryContainer: '#cce7f0',

		tertiary: '#b8c6ea',
		onTertiary: '#21304d',
		tertiaryContainer: '#384764',
		onTertiaryContainer: '#d8e2ff',

		error: '#ffb4a9',
		onError: '#690004',
		errorContainer: '#93000a',
		onErrorContainer: '#ffdad4',

		background: '#121212',
		onBackground: '#e4e2e6',
		surface: '#121212',
		onSurface: '#e4e2e6',
		// カード背景: 背景 #121212 よりはっきり明るい
		surfaceVariant: '#2a2d31',
		onSurfaceVariant: '#c4c7c7',

		// Divider 用にコントラスト強め
		outline: '#585b5f',
		outlineVariant: '#3a3d40',

		elevation: {
			...MD3DarkTheme.colors.elevation,
			level1: '#1f2123',
			level2: '#26292c',
			level3: '#2d3034',
		},
	},
};

export type AppTheme = typeof lightTheme;
