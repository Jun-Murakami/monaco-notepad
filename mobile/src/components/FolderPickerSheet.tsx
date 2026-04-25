import {
	BottomSheetBackdrop,
	type BottomSheetBackdropProps,
	BottomSheetModal,
	BottomSheetView,
} from '@gorhom/bottom-sheet';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View } from 'react-native';
import { Divider, Icon, Text, TouchableRipple, useTheme } from 'react-native-paper';
import type { Folder } from '@/services/sync/types';

export interface FolderPickerHandle {
	open: (currentFolderId: string, onSelect: (folderId: string) => void) => void;
	close: () => void;
}

interface Props {
	folders: Folder[];
}

/**
 * 「移動先フォルダ」を選ばせる bottom sheet。
 * imperative API で open/close するため、親側からは ref 経由で叩く。
 */
export const FolderPickerSheet = forwardRef<FolderPickerHandle, Props>(
	function FolderPickerSheet({ folders }, ref) {
		const { t } = useTranslation();
		const theme = useTheme();
		const sheetRef = useRef<BottomSheetModal>(null);
		const stateRef = useRef<{
			currentFolderId: string;
			onSelect: (folderId: string) => void;
		}>({
			currentFolderId: '',
			onSelect: () => {},
		});

		useImperativeHandle(ref, () => ({
			open: (currentFolderId, onSelect) => {
				stateRef.current = { currentFolderId, onSelect };
				sheetRef.current?.present();
			},
			close: () => sheetRef.current?.dismiss(),
		}));

		const renderBackdrop = useCallback(
			(props: BottomSheetBackdropProps) => (
				<BottomSheetBackdrop
					{...props}
					disappearsOnIndex={-1}
					appearsOnIndex={0}
					opacity={0.4}
				/>
			),
			[],
		);

		const handleSelect = (folderId: string) => {
			const { onSelect, currentFolderId } = stateRef.current;
			sheetRef.current?.dismiss();
			if (folderId !== currentFolderId) onSelect(folderId);
		};

		// "(top level)" + 各フォルダ。アーカイブ済みフォルダは除外。
		const items: Array<{ id: string; name: string; icon: string }> = [
			{
				id: '',
				name: t('noteList.moveToTopLevel'),
				icon: 'folder-outline',
			},
			...folders
				.filter((f) => !f.archived)
				.map((f) => ({ id: f.id, name: f.name, icon: 'folder' })),
		];

		return (
			<BottomSheetModal
				ref={sheetRef}
				snapPoints={['50%']}
				enablePanDownToClose
				backdropComponent={renderBackdrop}
				backgroundStyle={{ backgroundColor: theme.colors.elevation.level2 }}
				handleIndicatorStyle={{ backgroundColor: theme.colors.outline }}
			>
				<BottomSheetView style={styles.container}>
					<Text
						variant="titleMedium"
						style={[styles.header, { color: theme.colors.onSurface }]}
					>
						{t('noteList.moveToFolder')}
					</Text>
					<Divider />
					<FlatList
						data={items}
						keyExtractor={(it) => it.id || 'top'}
						renderItem={({ item }) => {
							const isCurrent = item.id === stateRef.current.currentFolderId;
							return (
								<TouchableRipple
									onPress={() => handleSelect(item.id)}
									style={styles.row}
									rippleColor={theme.colors.surfaceVariant}
								>
									<View style={styles.rowInner}>
										<Icon
											source={item.icon}
											size={20}
											color={
												isCurrent ? theme.colors.primary : theme.colors.onSurface
											}
										/>
										<Text
											variant="bodyMedium"
											style={[
												styles.rowName,
												{
													color: isCurrent
														? theme.colors.primary
														: theme.colors.onSurface,
												},
											]}
											numberOfLines={1}
										>
											{item.name}
										</Text>
										{isCurrent && (
											<Icon
												source="check"
												size={18}
												color={theme.colors.primary}
											/>
										)}
									</View>
								</TouchableRipple>
							);
						}}
						ItemSeparatorComponent={() => <Divider />}
					/>
				</BottomSheetView>
			</BottomSheetModal>
		);
	},
);

const styles = StyleSheet.create({
	container: { flex: 1 },
	header: { paddingHorizontal: 16, paddingVertical: 12 },
	row: { paddingHorizontal: 16, paddingVertical: 14 },
	rowInner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
	},
	rowName: { flex: 1 },
});
