import dayjs from 'dayjs';
import 'dayjs/locale/ja';
import 'dayjs/locale/en';
import localizedFormat from 'dayjs/plugin/localizedFormat';

// プラグインを追加
dayjs.extend(localizedFormat);

// ブラウザのロケールに基づいてdayjsのロケールを設定
const userLocale = navigator.language.toLowerCase().split('-')[0];
dayjs.locale(userLocale);

export default dayjs;
