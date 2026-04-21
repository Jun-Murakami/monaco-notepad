import * as Localization from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';
import ja from './locales/ja/common.json';

const deviceLocale = Localization.getLocales()[0]?.languageCode ?? 'en';
const initialLang = deviceLocale === 'ja' ? 'ja' : 'en';

i18n.use(initReactI18next).init({
	resources: {
		en: { common: en },
		ja: { common: ja },
	},
	lng: initialLang,
	fallbackLng: 'en',
	defaultNS: 'common',
	interpolation: { escapeValue: false },
});

export default i18n;
