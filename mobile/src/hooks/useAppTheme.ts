import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { appSettings, type ThemePref } from '@/services/settings/appSettings';
import { type AppTheme, darkTheme, lightTheme } from '@/theme';

/**
 * ユーザーの theme 設定を appSettings から読み、OS の配色設定と合成して
 * 実際に使う AppTheme を返す。
 *
 * - `auto`: OS の配色に従う
 * - `light` / `dark`: ユーザー指定を優先
 */
export function useAppTheme(): {
	theme: AppTheme;
	isDark: boolean;
	pref: ThemePref;
} {
	const osScheme = useColorScheme();
	const [pref, setPref] = useState<ThemePref>(
		() => appSettings.snapshot().theme,
	);

	useEffect(() => {
		return appSettings.subscribe((s) => setPref(s.theme));
	}, []);

	const isDark = pref === 'dark' || (pref === 'auto' && osScheme === 'dark');
	return {
		theme: isDark ? darkTheme : lightTheme,
		isDark,
		pref,
	};
}
