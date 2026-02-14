import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ja from './locales/ja/common.json';
import en from './locales/en/common.json';

const resources = {
	ja: { translation: ja },
	en: { translation: en },
};

type SupportedLocale = 'en' | 'ja';
type InitialLocale = 'system' | SupportedLocale;

const toSupportedLocale = (locale?: string): SupportedLocale => {
	if (!locale) {
		return 'en';
	}

	const normalized = locale.toLowerCase().split(/[-_]/)[0];
	return normalized === 'ja' ? 'ja' : 'en';
};

const resolveInitialLocale = (initialLocale: InitialLocale): SupportedLocale => {
	if (initialLocale !== 'system') {
		return toSupportedLocale(initialLocale);
	}

	if (typeof navigator !== 'undefined') {
		return toSupportedLocale(navigator.language);
	}

	return 'en';
};

export function initI18n(initialLocale: InitialLocale = 'system') {
	i18n.use(initReactI18next).init({
		resources,
		lng: resolveInitialLocale(initialLocale),
		fallbackLng: 'en',
		supportedLngs: ['en', 'ja'],
		interpolation: {
			escapeValue: false,
		},
		react: {
			useSuspense: false,
		},
	});

	return i18n;
}

export function changeLanguage(lng: 'en' | 'ja') {
	return i18n.changeLanguage(lng);
}

export function getCurrentLanguage(): string {
	return i18n.language || 'en';
}

export default i18n;
