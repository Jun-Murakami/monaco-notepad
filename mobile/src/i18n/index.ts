import * as Localization from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
	appSettings,
	type LanguagePref,
} from '@/services/settings/appSettings';
import en from './locales/en/common.json';
import ja from './locales/ja/common.json';

/**
 * 言語解決のロジック:
 *   1. ユーザーが明示的に選んだ言語 (appSettings.language) があればそれを使う
 *   2. 未設定 (auto) なら OS 言語から判定: `ja` 系なら `ja`、それ以外は `en`
 *
 * 起動時は OS 言語で即 init（同期）し、その後 appSettings.load() 完了後に
 * applySavedLanguage() で上書きする。これにより FS 読み込みで UI をブロックしない。
 */

function detectOsLanguage(): 'ja' | 'en' {
	const code = Localization.getLocales()[0]?.languageCode ?? 'en';
	return code === 'ja' ? 'ja' : 'en';
}

function resolveLanguage(pref: LanguagePref): 'ja' | 'en' {
	if (pref === 'ja' || pref === 'en') return pref;
	return detectOsLanguage();
}

i18n.use(initReactI18next).init({
	resources: {
		en: { common: en },
		ja: { common: ja },
	},
	lng: detectOsLanguage(),
	fallbackLng: 'en',
	defaultNS: 'common',
	interpolation: { escapeValue: false },
});

/** 保存済みの言語設定を i18n に反映。useInitialize から呼ぶ。 */
export async function applySavedLanguage(): Promise<void> {
	await appSettings.load();
	const target = resolveLanguage(appSettings.snapshot().language);
	if (i18n.language !== target) {
		await i18n.changeLanguage(target);
	}
}

/** 設定画面から呼ぶ。保存 + 即時反映。 */
export async function setLanguage(pref: LanguagePref): Promise<void> {
	await appSettings.update({ language: pref });
	const target = resolveLanguage(pref);
	if (i18n.language !== target) {
		await i18n.changeLanguage(target);
	}
}

export default i18n;
