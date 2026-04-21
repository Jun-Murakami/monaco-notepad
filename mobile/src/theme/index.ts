import { MD3DarkTheme, MD3LightTheme } from 'react-native-paper';

export const lightTheme = {
	...MD3LightTheme,
	colors: {
		...MD3LightTheme.colors,
		primary: '#1F6FEB',
		secondary: '#6B7280',
	},
};

export const darkTheme = {
	...MD3DarkTheme,
	colors: {
		...MD3DarkTheme.colors,
		primary: '#58A6FF',
		secondary: '#9CA3AF',
	},
};

export type AppTheme = typeof lightTheme;
