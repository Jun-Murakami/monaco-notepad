import { type ReactNode, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, {
	type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Icon, Text, TouchableRipple, useTheme } from 'react-native-paper';
import Animated, {
	type SharedValue,
	useAnimatedStyle,
} from 'react-native-reanimated';

interface Props {
	children: ReactNode;
	onArchive: () => void;
	/** スワイプ操作を無効化したい場合（フォルダヘッダ等）。 */
	disabled?: boolean;
}

const ARCHIVE_BUTTON_WIDTH = 88;

/**
 * 左スワイプで右側からアーカイブボタンが現れるラッパ。
 *
 * GitHub モバイルなどと同じ「行を引いて、下に隠れていたボタンが見える」パターン。
 * フルスワイプでの即時アーカイブはせず、必ずタップで確定させる。
 */
export function SwipeableNoteRow({ children, onArchive, disabled }: Props) {
	const ref = useRef<SwipeableMethods | null>(null);
	const { t } = useTranslation();
	const theme = useTheme();

	if (disabled) {
		return <View>{children}</View>;
	}

	const renderRightActions = (
		_progress: SharedValue<number>,
		drag: SharedValue<number>,
	) => <RightActions drag={drag} onPress={handlePress} buttonText={t('noteList.archive_action')} background={theme.colors.tertiary} foreground={theme.colors.onTertiary} />;

	function handlePress() {
		ref.current?.close();
		onArchive();
	}

	return (
		<ReanimatedSwipeable
			ref={ref}
			friction={2}
			rightThreshold={ARCHIVE_BUTTON_WIDTH / 2}
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
	onPress: () => void;
	buttonText: string;
	background: string;
	foreground: string;
}

function RightActions({
	drag,
	onPress,
	buttonText,
	background,
	foreground,
}: RightActionsProps) {
	// drag が -ARCHIVE_BUTTON_WIDTH まで来た時にボタン全幅。スワイプの引き具合に追随させる。
	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: drag.value + ARCHIVE_BUTTON_WIDTH }],
	}));
	return (
		<View style={styles.rightActionsBox}>
			<Animated.View
				style={[
					styles.actionContainer,
					{ width: ARCHIVE_BUTTON_WIDTH, backgroundColor: background },
					animatedStyle,
				]}
			>
				<TouchableRipple
					onPress={onPress}
					style={styles.actionTouchable}
					rippleColor={foreground}
					accessibilityLabel={buttonText}
				>
					<View style={styles.actionInner}>
						<Icon source="archive-arrow-down" size={20} color={foreground} />
						<Text variant="labelSmall" style={[styles.actionText, { color: foreground }]}>
							{buttonText}
						</Text>
					</View>
				</TouchableRipple>
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
		width: ARCHIVE_BUTTON_WIDTH,
	},
	actionContainer: {
		height: '100%',
	},
	actionTouchable: {
		flex: 1,
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
