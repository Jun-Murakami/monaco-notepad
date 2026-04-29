import { Platform } from 'react-native';

// iPad 判定。iPad は横幅が広く、ホーム画面のアプリタイトルを左寄せのまま放置すると
// 右のアクション群との間に大きな空白が生まれて間延びして見える。
// この場合だけ AppBar 全幅に対して絶対配置でタイトルを中央寄せするために使う。
export const IS_IOS_TABLET = Platform.OS === 'ios' && Platform.isPad;
