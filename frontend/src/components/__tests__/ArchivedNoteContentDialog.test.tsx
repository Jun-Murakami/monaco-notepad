import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

const {
  model,
  monacoCreate,
  setModelLanguage,
  setTheme,
  loadArchivedNoteMock,
} = vi.hoisted(() => {
  const model = {
    value: '',
    languageId: 'plaintext',
    getValue: vi.fn(() => model.value),
    setValue: vi.fn((nextValue: string) => {
      model.value = nextValue;
    }),
    getLanguageId: vi.fn(() => model.languageId),
    dispose: vi.fn(),
  };

  const editor = {
    getModel: vi.fn(() => model),
    dispose: vi.fn(),
  };

  return {
    model,
    monacoCreate: vi.fn(() => editor),
    setModelLanguage: vi.fn((_model: typeof model, nextLanguage: string) => {
      model.languageId = nextLanguage;
    }),
    setTheme: vi.fn(),
    loadArchivedNoteMock: vi.fn(),
  };
});

vi.mock('monaco-editor', () => ({
  editor: {
    create: monacoCreate,
    setModelLanguage,
    setTheme,
  },
}));

vi.mock('../../../wailsjs/go/backend/App', () => ({
  LoadArchivedNote: loadArchivedNoteMock,
}));

import { ArchivedNoteContentDialog } from '../ArchivedNoteContentDialog';

import type { Note } from '../../types';

describe('ArchivedNoteContentDialog', () => {
  const note1: Note = {
    id: 'note-1',
    title: 'Archived 1',
    content: '',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: '2024-01-01T10:00:00.000Z',
    archived: true,
  };

  const note2: Note = {
    ...note1,
    id: 'note-2',
    title: 'Archived 2',
    language: 'markdown',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    model.value = '';
    model.languageId = 'plaintext';
  });

  it('内容や表示テーマが変わっても Monaco エディタを作り直さないこと', async () => {
    loadArchivedNoteMock
      .mockResolvedValueOnce({ content: 'first content' })
      .mockResolvedValueOnce({ content: 'second content' });

    const { rerender } = render(
      <ArchivedNoteContentDialog
        open
        note={note1}
        onClose={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        isDarkMode={false}
      />,
    );

    await waitFor(() => {
      expect(model.setValue).toHaveBeenCalledWith('first content');
    });

    rerender(
      <ArchivedNoteContentDialog
        open
        note={note2}
        onClose={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        isDarkMode
      />,
    );

    await waitFor(() => {
      expect(model.setValue).toHaveBeenCalledWith('second content');
    });

    expect(monacoCreate).toHaveBeenCalledTimes(1);
    expect(setModelLanguage).toHaveBeenCalledWith(model, 'markdown');
    expect(setTheme).toHaveBeenLastCalledWith('vs-dark');
  });
});
