import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

/**
 * OAuth コールバック着地点。
 *
 * expo-auth-session が Android/iOS で deep link `monaconotepad://oauth2redirect?code=...` を
 * 受信し、内部リスナーで処理する。その後 Expo Router もこの URL をナビゲーションとして解釈するため、
 * 対応するルートがないと "Unmatched Route" 画面が一瞬表示される。
 *
 * 実際の認証処理は signin.tsx の onSignIn で進行中なので、ここでは自分自身を畳んで
 * 即座に元の画面（signin）に戻す。畳んだあとは signin.tsx 側の router.replace('/') が
 * 走ることで home へ辿り着く。
 *
 * `<Redirect href="/" />` ではスタックに `/signin` が残ったまま top が / に置換されるため、
 * その後の router.back() が `/signin` に戻ってしまうバグを引き起こす。
 */
export default function OAuth2RedirectScreen() {
	const router = useRouter();
	useEffect(() => {
		if (router.canGoBack()) {
			router.back();
		} else {
			router.replace('/');
		}
	}, [router]);
	return <View />;
}
