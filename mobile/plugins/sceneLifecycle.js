/**
 * iOS のシーン（UIScene）ライフサイクル対応。prebuild で生成する AppDelegate.swift と Info.plist を書き換える。
 *
 * iOS 27 の SDK でビルドしたアプリは、シーン型のライフサイクルを採用していないと起動時に停止する
 * （UIKit の `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`。1.7.1 (16) が App Review で
 * 起動直後にクラッシュしてリジェクトされた原因）。Expo SDK 57 はシーン用の `ExpoAppSceneDelegate` を
 * 用意しているが、prebuild のひな形はまだ AppDelegate がウィンドウを作る旧来の形なので、ここで切り替える。
 *
 * - Info.plist: `UIApplicationSceneManifest` でシーンの担当を `ExpoAppSceneDelegate` にする
 * - AppDelegate: `ExpoReactNativeFactoryProvider` に準拠させ、ウィンドウの作成と React Native の起動をやめる
 *   （シーン側が自分のウィンドウでこのファクトリを起動する。ディープリンク等もシーン側から AppDelegate へ転送される）
 *
 * Expo のひな形がシーン対応したら、このプラグインは外せる。
 */

/** Info.plist の `UIApplicationSceneManifest`。クラス名は `ExpoAppSceneDelegate` の Objective-C 名。 */
const SCENE_MANIFEST = {
	UIApplicationSupportsMultipleScenes: false,
	UISceneConfigurations: {
		UIWindowSceneSessionRoleApplication: [
			{
				UISceneConfigurationName: 'Default Configuration',
				UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
			},
		],
	},
};

const PROVIDER = 'ExpoReactNativeFactoryProvider';
const CLASS_DECLARATION = /class AppDelegate: ExpoAppDelegate \{/;
// ひな形の「ウィンドウを作って React Native を起動する」部分
const START_IN_APP_DELEGATE =
	/\r?\n#if os\(iOS\) \|\| os\(tvOS\)\r?\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\r?\n\s*factory\.startReactNative\([\s\S]*?\)\r?\n#endif\r?\n/;

/**
 * SDK 57 のひな形の AppDelegate.swift をシーン型のライフサイクル用に書き換える（適用済みならそのまま返す）。
 * @param {string} contents
 * @returns {string}
 */
function adoptSceneLifecycle(contents) {
	const adopted =
		contents.includes(`ExpoAppDelegate, ${PROVIDER}`) &&
		!contents.includes('startReactNative(');
	if (adopted) return contents;
	if (
		!CLASS_DECLARATION.test(contents) ||
		!START_IN_APP_DELEGATE.test(contents)
	) {
		throw new Error(
			'withSceneLifecycle: AppDelegate.swift の形が想定と違うため、iOS のシーン（UIScene）対応を適用できません。' +
				'Expo のひな形の変更を確認してください（iOS 27 の SDK では対応しないと起動時に停止します）。',
		);
	}
	return contents
		.replace(
			CLASS_DECLARATION,
			`class AppDelegate: ExpoAppDelegate, ${PROVIDER} {`,
		)
		.replace(
			START_IN_APP_DELEGATE,
			'\n    // ウィンドウの作成と React Native の起動は ExpoAppSceneDelegate（Info.plist の\n' +
				'    // UIApplicationSceneManifest）が行う。iOS 27 の SDK ではシーン対応が必須（plugins/sceneLifecycle.js）\n',
		);
}

module.exports = { SCENE_MANIFEST, adoptSceneLifecycle };
