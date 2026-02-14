import type { Note, TopLevelItem } from '../types';

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const isSameTopLevelOrder = (
  a: TopLevelItem[],
  b: TopLevelItem[],
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.type !== b[i]?.type || a[i]?.id !== b[i]?.id) {
      return false;
    }
  }
  return true;
};

export const removeTopLevelNote = (
  order: TopLevelItem[],
  noteId: string,
): TopLevelItem[] =>
  order.filter((item) => !(item.type === 'note' && item.id === noteId));

export const insertTopLevelNote = (
  order: TopLevelItem[],
  noteId: string,
  index: number,
): TopLevelItem[] => {
  const currentIndex = order.findIndex(
    (item) => item.type === 'note' && item.id === noteId,
  );
  const without = removeTopLevelNote(order, noteId);
  let insertAt = index;
  if (currentIndex !== -1 && currentIndex < insertAt) {
    insertAt -= 1;
  }
  insertAt = clamp(insertAt, 0, without.length);
  without.splice(insertAt, 0, { type: 'note', id: noteId });
  return without;
};

export const moveTopLevelItem = (
  order: TopLevelItem[],
  itemType: 'note' | 'folder',
  itemId: string,
  insertIndex: number,
): TopLevelItem[] => {
  const currentIndex = order.findIndex(
    (item) => item.type === itemType && item.id === itemId,
  );
  if (currentIndex === -1) return order;
  const moving = order[currentIndex];
  const without = order.filter((_, index) => index !== currentIndex);
  let safeIndex = insertIndex;
  if (currentIndex < safeIndex) {
    safeIndex -= 1;
  }
  safeIndex = clamp(safeIndex, 0, without.length);
  without.splice(safeIndex, 0, moving);
  return without;
};

export const moveNoteWithinActiveList = (
  activeNotes: Note[],
  noteId: string,
  targetFolderId: string,
  positionInFolder: number,
): {
  newActive: Note[];
  insertIndex: number;
} | null => {
  const source = activeNotes.find((note) => note.id === noteId);
  if (!source) return null;

  const notesWithout = activeNotes.filter((note) => note.id !== noteId);
  const sourceIndex = activeNotes.findIndex((note) => note.id === noteId);
  const normalizedFolderId = targetFolderId || '';

  const targetPositions: number[] = [];
  notesWithout.forEach((note, index) => {
    if ((note.folderId ?? '') === normalizedFolderId) {
      targetPositions.push(index);
    }
  });

  let insertIndex = sourceIndex;
  if (targetPositions.length === 0) {
    insertIndex = clamp(sourceIndex, 0, notesWithout.length);
  } else if (positionInFolder <= 0) {
    insertIndex = targetPositions[0];
  } else if (positionInFolder >= targetPositions.length) {
    insertIndex = targetPositions[targetPositions.length - 1] + 1;
  } else {
    insertIndex = targetPositions[positionInFolder];
  }

  const moved: Note =
    (source.folderId ?? '') === normalizedFolderId
      ? source
      : {
          ...source,
          folderId: normalizedFolderId || undefined,
        };

  const newActive = [
    ...notesWithout.slice(0, insertIndex),
    moved,
    ...notesWithout.slice(insertIndex),
  ];

  return { newActive, insertIndex };
};
