import { type NativeModule, requireNativeModule } from 'expo';
import type { TextInput } from 'react-native';

export interface NativeCaretRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

// ネイティブ側は reactTag を使わず、UITextView.textDidBeginEditingNotification
// でキャッシュした参照を使う。Fabric (New Architecture) では findNodeHandle が
// null を返すため、reactTag パラメータには互換性のためダミー値 (0) を渡す。

declare class MonacoCaretPositionModule extends NativeModule {
	getCaretRect(
		reactTag: number,
		offset: number,
	): Promise<NativeCaretRect | null>;
	suppressAutoScroll(reactTag: number): Promise<boolean>;
	scrollCaretToVisibleCenter(
		reactTag: number,
		offset: number,
		visibleHeight: number,
		bottomInset: number,
		animated: boolean,
	): Promise<boolean>;
}

let nativeModule: MonacoCaretPositionModule | null | undefined;

function getNativeModule(): MonacoCaretPositionModule | null {
	if (nativeModule !== undefined) return nativeModule;
	try {
		nativeModule = requireNativeModule<MonacoCaretPositionModule>(
			'MonacoCaretPosition',
		);
	} catch {
		// Expo Go / prebuild 前 / web では native module が存在しない。
		// 呼び出し側は計測用 Text の fallback に自然に戻る。
		nativeModule = null;
	}
	return nativeModule;
}

export async function getTextInputCaretRect(
	_input: TextInput | null,
	offset: number,
): Promise<NativeCaretRect | null> {
	const module = getNativeModule();
	if (!module) return null;

	try {
		return await module.getCaretRect(0, offset);
	} catch {
		return null;
	}
}

/**
 * UITextView の scrollEnabled を一時的に false にして、
 * focus (becomeFirstResponder) 時の scrollRangeToVisible 自動スクロールを抑制する。
 * scrollTextInputCaretToVisibleCenter が scrollEnabled を復元するため、
 * 必ずペアで呼ぶこと。iOS 専用。
 */
export async function suppressTextInputAutoScroll(): Promise<boolean> {
	const module = getNativeModule();
	if (!module) return false;

	try {
		return await module.suppressAutoScroll(0);
	} catch {
		return false;
	}
}

export async function scrollTextInputCaretToVisibleCenter(
	_input: TextInput | null,
	offset: number,
	visibleHeight: number,
	bottomInset: number,
	animated: boolean,
): Promise<boolean> {
	const module = getNativeModule();
	if (!module) return false;

	try {
		return await module.scrollCaretToVisibleCenter(
			0,
			offset,
			visibleHeight,
			bottomInset,
			animated,
		);
	} catch {
		return false;
	}
}
