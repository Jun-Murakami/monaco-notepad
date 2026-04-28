import { type ReactNode, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, {
	type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import Animated, {
	type SharedValue,
	useAnimatedStyle,
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

/**
 * 左スワイプで右側からアクションボタンが現れるラッパ。
 *
 * GitHub モバイルなどと同じ「行を引いて、下に隠れていたボタンが見える」パターン。
 * フルスワイプでの即時実行はせず、必ずタップで確定させる。複数アクションは横並び。
 */
export function SwipeableNoteRow({ children, actions, disabled }: Props) {
	const ref = useRef<SwipeableMethods | null>(null);

	if (disabled || actions.length === 0) {
		return <View>{children}</View>;
	}

	const totalWidth = actions.length * ACTION_BUTTON_WIDTH;

	const handlePressAction = (onPress: () => void) => {
		ref.current?.close();
		onPress();
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
		<ReanimatedSwipeable
			ref={ref}
			friction={2}
			rightThreshold={ACTION_BUTTON_WIDTH / 2}
			overshootRight={false}
			renderRightActions={renderRightActions}
			containerStyle={styles.container}
		>
			{children}
		</ReanimatedSwipeable>
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
