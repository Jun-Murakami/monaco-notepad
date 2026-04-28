import { Fragment } from 'react';
import { StyleSheet, View } from 'react-native';
import { Divider, Menu } from 'react-native-paper';

interface Anchor {
	x: number;
	y: number;
}

export interface FolderMenuItem {
	icon: string;
	label: string;
	onPress: () => void;
}

interface Props {
	visible: boolean;
	anchor: Anchor | null;
	onDismiss: () => void;
	items: FolderMenuItem[];
}

/** フォルダヘッダ右端のドットボタンから出すメニュー。
 *  項目はアクティブ画面とアーカイブ画面で切り替えるため、parent から `items` で渡す。 */
export function FolderContextMenu({
	visible,
	anchor,
	onDismiss,
	items,
}: Props) {
	return (
		<Menu
			visible={visible}
			onDismiss={onDismiss}
			anchor={anchor ?? <View style={styles.zeroAnchor} />}
		>
			{items.map((item, idx) => (
				// 同じ画面内で同じ icon+label のメニュー項目は並ばないので unique。
				<Fragment key={`${item.icon}:${item.label}`}>
					{idx > 0 && <Divider />}
					<Menu.Item
						leadingIcon={item.icon}
						onPress={() => {
							onDismiss();
							item.onPress();
						}}
						title={item.label}
					/>
				</Fragment>
			))}
		</Menu>
	);
}

const styles = StyleSheet.create({
	zeroAnchor: { width: 0, height: 0 },
});
