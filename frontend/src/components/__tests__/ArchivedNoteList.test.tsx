import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import '@testing-library/jest-dom';
import { ArchivedNoteList } from '../ArchivedNoteList';
import type { Note } from '../../types';
import dayjs from 'dayjs';

describe('ArchivedNoteList', () => {
  const mockNotes: Note[] = [
    {
      id: '1',
      title: 'Archived Note 1',
      content: 'Content 1',
      contentHeader: null,
      language: 'typescript',
      modifiedTime: '2024-01-01T10:00:00.000Z',
      archived: true,
    },
    {
      id: '2',
      title: '',
      content: 'First line\nSecond line',
      contentHeader: null,
      language: 'typescript',
      modifiedTime: '2024-01-02T10:00:00.000Z',
      archived: true,
    },
    {
      id: '3',
      title: '',
      content: '',
      contentHeader: null,
      language: 'typescript',
      modifiedTime: '2024-01-03T10:00:00.000Z',
      archived: true,
    },
  ];

  const defaultProps = {
    notes: mockNotes,
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
    onDeleteAll: vi.fn(),
    onClose: vi.fn(),
  };

  it('アーカイブされたノートがない場合、メッセージが表示されること', () => {
    render(<ArchivedNoteList {...defaultProps} notes={[]} />);
    expect(screen.getByText('No archived notes')).toBeInTheDocument();
  });

  it('アーカイブされたノートが正しく表示されること', () => {
    render(<ArchivedNoteList {...defaultProps} />);

    expect(screen.getByText('Archived Note 1')).toBeInTheDocument();
    expect(screen.getByText('First line')).toBeInTheDocument();
    expect(screen.getByText('Empty Note')).toBeInTheDocument();

    // 日付が正しく表示されることを確認
    for (const note of mockNotes) {
      const formattedDate = dayjs(note.modifiedTime).format('L HH:mm:ss');
      const dateElements = screen.getAllByText(formattedDate);
      expect(dateElements.length).toBeGreaterThan(0);
    }
  });

  it('タイトルの表示ロジックが正しく動作すること', () => {
    const notesWithVariousTitles: Note[] = [
      {
        ...mockNotes[0],
        title: '   ',
        content: 'Content from content',
      },
      {
        ...mockNotes[1],
        title: '',
        content: '   \n   \n',
      },
      {
        ...mockNotes[2],
        title: 'Explicit Title',
        content: 'Content should not be used',
      },
    ];

    render(<ArchivedNoteList {...defaultProps} notes={notesWithVariousTitles} />);

    expect(screen.getByText('Content from content')).toBeInTheDocument();
    expect(screen.getByText('Empty Note')).toBeInTheDocument();
    expect(screen.getByText('Explicit Title')).toBeInTheDocument();
  });

  it('アンアーカイブボタンが正しく動作すること', () => {
    render(<ArchivedNoteList {...defaultProps} />);

    const unarchiveButtons = screen.getAllByRole('button', { name: 'Unarchive' });
    fireEvent.click(unarchiveButtons[0]);

    expect(defaultProps.onUnarchive).toHaveBeenCalledWith('1');
  });

  it('削除ボタンが正しく動作すること', () => {
    render(<ArchivedNoteList {...defaultProps} />);

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButtons[0]);

    expect(defaultProps.onDelete).toHaveBeenCalledWith('1');
  });

  it('全削除ボタンが正しく動作すること', () => {
    render(<ArchivedNoteList {...defaultProps} />);

    const deleteAllButton = screen.getByRole('button', { name: 'Delete all archived notes' });
    fireEvent.click(deleteAllButton);

    expect(defaultProps.onDeleteAll).toHaveBeenCalled();
  });

  it('戻るボタンが正しく動作すること', () => {
    render(<ArchivedNoteList {...defaultProps} />);

    const backButton = screen.getByTestId('ArrowBackIcon').closest('button');
    if (backButton) {
      fireEvent.click(backButton);
      expect(defaultProps.onClose).toHaveBeenCalled();
    } else {
      throw new Error('Back button not found');
    }
  });
});
