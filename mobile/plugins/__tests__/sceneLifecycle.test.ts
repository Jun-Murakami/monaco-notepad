import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 設定プラグインは Expo の設定ローダーが読めるよう CommonJS で書いている
const { adoptSceneLifecycle, SCENE_MANIFEST } = createRequire(import.meta.url)(
	'../sceneLifecycle.js',
) as {
	adoptSceneLifecycle: (contents: string) => string;
	SCENE_MANIFEST: unknown;
};

const fixture = readFileSync(
	path.join(__dirname, 'fixtures', 'AppDelegate.sdk57.swift'),
	'utf8',
);
const expoAppDelegates = path.join(
	__dirname,
	'..',
	'..',
	'node_modules',
	'expo',
	'ios',
	'AppDelegates',
);

describe('iOS のシーン（UIScene）ライフサイクル対応', () => {
	it('AppDelegate は React Native のファクトリを渡すだけにし、ウィンドウは作らない', () => {
		const out = adoptSceneLifecycle(fixture);
		expect(out).toContain(
			'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {',
		);
		// ウィンドウの作成と React Native の起動はシーン側（ExpoAppSceneDelegate）が行う
		expect(out).not.toContain('UIWindow(frame:');
		expect(out).not.toContain('startReactNative(');
		// ファクトリは今までどおり作って保持する（シーン側がこれを使う）
		expect(out).toContain(
			'let factory = ExpoReactNativeFactory(delegate: delegate)',
		);
		expect(out).toContain('reactNativeFactory = factory');
		expect(out).toContain(
			'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
		);
		// ディープリンクの受け口は残す（シーン側から転送される）
		expect(out).toContain(
			'RCTLinkingManager.application(app, open: url, options: options)',
		);
	});

	it('2 回適用しても変わらない（prebuild を繰り返しても壊れない）', () => {
		const once = adoptSceneLifecycle(fixture);
		expect(adoptSceneLifecycle(once)).toBe(once);
	});

	it('想定外の AppDelegate なら黙って通さずに止める', () => {
		expect(() =>
			adoptSceneLifecycle('@main\nclass AppDelegate: UIResponder {}\n'),
		).toThrow(/scene/i);
	});

	it('Info.plist ではシーンの担当に Expo の ExpoAppSceneDelegate を指定する（ウィンドウは 1 つ）', () => {
		expect(SCENE_MANIFEST).toEqual({
			UIApplicationSupportsMultipleScenes: false,
			UISceneConfigurations: {
				UIWindowSceneSessionRoleApplication: [
					{
						UISceneConfigurationName: 'Default Configuration',
						UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
					},
				],
			},
		});
	});

	it('指定するクラス名とプロトコルは、入っている Expo の実物と一致する', () => {
		const sceneDelegate = readFileSync(
			path.join(expoAppDelegates, 'ExpoAppSceneDelegate.swift'),
			'utf8',
		);
		expect(sceneDelegate).toMatch(
			/@objc\(EXExpoAppSceneDelegate\)\s+open class ExpoAppSceneDelegate\b/,
		);
		const provider = readFileSync(
			path.join(expoAppDelegates, 'ExpoReactNativeFactoryProvider.swift'),
			'utf8',
		);
		expect(provider).toContain(
			'public protocol ExpoReactNativeFactoryProvider',
		);
		expect(provider).toContain('var window: UIWindow? { get set }');
		expect(provider).toContain(
			'var reactNativeFactory: RCTReactNativeFactory? { get }',
		);
	});
});
