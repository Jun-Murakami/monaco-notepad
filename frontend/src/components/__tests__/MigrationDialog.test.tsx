import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { RespondToMigration } from '../../../wailsjs/go/backend/App';
import { MigrationDialog } from '../MigrationDialog';

vi.mock('../../../wailsjs/go/backend/App', () => ({
  RespondToMigration: vi.fn().mockResolvedValue(undefined),
}));

describe('MigrationDialog', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('open=trueでダイアログが表示されること', () => {
    render(<MigrationDialog open={true} onClose={mockOnClose} />);

    expect(screen.getByText('Cloud Storage Update')).toBeInTheDocument();
    expect(
      screen.getByText(/Cloud storage has been updated/),
    ).toBeInTheDocument();
    expect(screen.getByText('Migrate and remove old data')).toBeInTheDocument();
    expect(screen.getByText('Migrate and keep old data')).toBeInTheDocument();
    expect(screen.getByText('Skip for now')).toBeInTheDocument();
  });

  it('open=falseでダイアログが表示されないこと', () => {
    render(<MigrationDialog open={false} onClose={mockOnClose} />);

    expect(screen.queryByText('Cloud Storage Update')).not.toBeInTheDocument();
  });

  it('migrate_deleteボタンがRespondToMigrationに正しい値を渡すこと', async () => {
    render(<MigrationDialog open={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByText('Migrate and remove old data'));

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(RespondToMigration).toHaveBeenCalledWith('migrate_delete');
    });
  });

  it('migrate_keepボタンがRespondToMigrationに正しい値を渡すこと', async () => {
    render(<MigrationDialog open={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByText('Migrate and keep old data'));

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(RespondToMigration).toHaveBeenCalledWith('migrate_keep');
    });
  });

  it('skipボタンがRespondToMigrationに正しい値を渡すこと', async () => {
    render(<MigrationDialog open={true} onClose={mockOnClose} />);

    fireEvent.click(screen.getByText('Skip for now'));

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(RespondToMigration).toHaveBeenCalledWith('skip');
    });
  });
});
