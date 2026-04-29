import { type ReactNode, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
// ★ Pressable は gesture-handler 版を使う。子側の Pressable も同じく gesture-handler
// 版に揃えてあるため、Swipeable の Pan ジェスチャーと正しく競合・キャンセルが行われる。
import { Pressable } from 'react-native-gesture-handler';
import ReanimatedSwipeable, {
	type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import Animated, {
	runOnJS,
	type SharedValue,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from 'react-native-reanimated';

export interface SwipeAction {
	icon: string;
	label: string;
	onPress: () => void;
	background: string;
	foreground: string;
}

interface Props {
	children: ReactNode;
	actions: SwipeAction[];
	/** スワイプ操作を無効化したい場合（フォルダヘッダや drag overlay 中等）。 */
	disabled?: boolean;
}

const ACTION_BUTTON_WIDTH = 88;
const REMOVE_ANIMATION_MS = 180;

/**
 * 左スワイプで右側からアクションボタンが現れるラッパ。
 *
 * GitHub モバイルなどと同じ「行を引いて、下に隠れていたボタンが見える」パターン。
 * フルスワイプでの即時実行はせず、必ずタップで確定させる。複数アクションは横並び。
 */
export function SwipeableNoteRow({ children, actions, disabled }: Props) {
	const ref = useRef<SwipeableMethods | null>(null);
	const rowHeight = useSharedValue(0);
	const removing = useSharedValue(0);
	// 開いている / 開きかけの間は子の Pressable へのタップ伝播を止める。
	// スワイプを引いた直後に意図せず詳細画面へ遷移するのを防ぐため。
	const [isOpen, setIsOpen] = useState(false);

	const removeStyle = useAnimatedStyle(() => {
		if (rowHeight.value <= 0) {
			return {
				opacity: 1 - removing.value,
			};
		}
		return {
			height: rowHeight.value * (1 - removing.value),
			opacity: 1 - removing.value,
			overflow: 'hidden',
		};
	});

	if (disabled || actions.length === 0) {
		return <View>{children}</View>;
	}

	const totalWidth = actions.length * ACTION_BUTTON_WIDTH;

	const handlePressAction = (onPress: () => void) => {
		if (removing.value !== 0) return;
		// アクション確定時は swipeable を閉じない。横に戻る途中で消えるより、
		// 開いた状態のまま高さを畳む方が「その行がリストから抜けた」ことが
		// 視覚的に分かりやすい。
		removing.value = withTiming(
			1,
			{ duration: REMOVE_ANIMATION_MS },
			(finished) => {
				if (finished) {
					runOnJS(onPress)();
				}
			},
		);
	};

	const renderRightActions = (
		_progress: SharedValue<number>,
		drag: SharedValue<number>,
	) => (
		<RightActions
			drag={drag}
			actions={actions}
			totalWidth={totalWidth}
			onPress={handlePressAction}
		/>
	);

	return (
		<Animated.View
			onLayout={(event) => {
				if (removing.value === 0) {
					rowHeight.value = event.nativeEvent.layout.height;
				}
			}}
			style={removeStyle}
		>
			<ReanimatedSwipeable
				ref={ref}
				friction={2}
				rightThreshold={ACTION_BUTTON_WIDTH / 2}
				overshootRight={false}
				renderRightActions={renderRightActions}
				containerStyle={styles.container}
				onSwipeableWillOpen={() => setIsOpen(true)}
				onSwipeableWillClose={() => setIsOpen(false)}
			>
				{children}
				{isOpen && (
					<Pressable
						style={StyleSheet.absoluteFill}
						onPress={() => ref.current?.close()}
					/>
				)}
			</ReanimatedSwipeable>
		</Animated.View>
	);
}

interface RightActionsProps {
	drag: SharedValue<number>;
	actions: SwipeAction[];
	totalWidth: number;
	onPress: (handler: () => void) => void;
}

function RightActions({
	drag,
	actions,
	totalWidth,
	onPress,
}: RightActionsProps) {
	// drag が -totalWidth まで来た時にバー全幅。スワイプの引き具合に追随させる。
	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: drag.value + totalWidth }],
	}));
	return (
		<View style={[styles.rightActionsBox, { width: totalWidth }]}>
			<Animated.View
				style={[styles.actionsRow, { width: totalWidth }, animatedStyle]}
			>
				{actions.map((action) => (
					<TouchableRipple
						// 同じ画面内で同じ icon+label のアクションは並ばないので unique。
						key={`${action.icon}:${action.label}`}
						onPress={() => onPress(action.onPress)}
						style={[
							styles.actionTouchable,
							{
								width: ACTION_BUTTON_WIDTH,
								backgroundColor: action.background,
							},
						]}
						rippleColor={action.foreground}
						accessibilityLabel={action.label}
					>
						<View style={styles.actionInner}>
							<Icon source={action.icon} size={20} color={action.foreground} />
							<Text
								variant="labelSmall"
								style={[styles.actionText, { color: action.foreground }]}
							>
								{action.label}
							</Text>
						</View>
					</TouchableRipple>
				))}
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		// 子の背景色をそのまま見せる（透過）
		backgroundColor: 'transparent',
	},
	rightActionsBox: {
		// container 自体は static。中の Animated.View でスライド。
	},
	actionsRow: {
		flexDirection: 'row',
		height: '100%',
	},
	actionTouchable: {
		height: '100%',
	},
	actionInner: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: 4,
	},
	actionText: {
		fontSize: 11,
	},
});
