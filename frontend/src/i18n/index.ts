import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ja from './locales/ja/common.json';
import en from './locales/en/common.json';

const resources = {
    ja: { translation: ja },
    en: { translation: en },
};

export function initI18n(initialLocale = 'en') {
    const resolvedLocale = initialLocale === 'system' ? 'en' : initialLocale;
    
    i18n.use(initReactI18next).init({
        resources,
        lng: resolvedLocale,
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
