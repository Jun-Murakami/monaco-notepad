import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Divider, Menu } from 'react-native-paper';

interface Anchor {
	x: number;
	y: number;
}

interface NoteMenuProps {
	visible: boolean;
	anchor: Anchor | null;
	onDismiss: () => void;
	onMoveToFolder: () => void;
	onArchive: () => void;
}

/** ノート行の長押しメニュー。 */
export function NoteContextMenu({
	visible,
	anchor,
	onDismiss,
	onMoveToFolder,
	onArchive,
}: NoteMenuProps) {
	const { t } = useTranslation();
	return (
		<Menu
			visible={visible}
			onDismiss={onDismiss}
			anchor={anchor ?? <View style={styles.zeroAnchor} />}
		>
			<Menu.Item
				leadingIcon="folder-move"
				onPress={() => {
					onDismiss();
					onMoveToFolder();
				}}
				title={t('noteList.moveToFolder')}
			/>
			<Divider />
			<Menu.Item
				leadingIcon="archive-arrow-down"
				onPress={() => {
					onDismiss();
					onArchive();
				}}
				title={t('noteList.archive_action')}
			/>
		</Menu>
	);
}

interface FolderMenuProps {
	visible: boolean;
	anchor: Anchor | null;
	onDismiss: () => void;
	onRename: () => void;
	onDelete: () => void;
}

/** フォルダヘッダ行の長押しメニュー。 */
export function FolderContextMenu({
	visible,
	anchor,
	onDismiss,
	onRename,
	onDelete,
}: FolderMenuProps) {
	const { t } = useTranslation();
	return (
		<Menu
			visible={visible}
			onDismiss={onDismiss}
			anchor={anchor ?? <View style={styles.zeroAnchor} />}
		>
			<Menu.Item
				leadingIcon="pencil"
				onPress={() => {
					onDismiss();
					onRename();
				}}
				title={t('noteList.renameFolder')}
			/>
			<Divider />
			<Menu.Item
				leadingIcon="trash-can"
				onPress={() => {
					onDismiss();
					onDelete();
				}}
				title={t('noteList.deleteFolder')}
			/>
		</Menu>
	);
}

const styles = StyleSheet.create({
	zeroAnchor: { width: 0, height: 0 },
});
