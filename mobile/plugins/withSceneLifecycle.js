// Expo の設定プラグイン: iOS のシーン（UIScene）ライフサイクルを採用する（詳細は sceneLifecycle.js）。
// app.config.ts の plugins からパスで読み込まれる（設定ローダーは TypeScript のプラグインを読めないので JS）。
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');
const { adoptSceneLifecycle, SCENE_MANIFEST } = require('./sceneLifecycle');

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withSceneLifecycle = (config) => {
	const withManifest = withInfoPlist(config, (c) => {
		c.modResults.UIApplicationSceneManifest = structuredClone(SCENE_MANIFEST);
		return c;
	});
	return withAppDelegate(withManifest, (c) => {
		if (c.modResults.language !== 'swift') {
			throw new Error(
				`withSceneLifecycle: AppDelegate が Swift ではありません（${c.modResults.language}）`,
			);
		}
		c.modResults.contents = adoptSceneLifecycle(c.modResults.contents);
		return c;
	});
};

module.exports = withSceneLifecycle;
