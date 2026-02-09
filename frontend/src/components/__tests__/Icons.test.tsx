import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EraseIcon, GoogleDriveIcon } from '../Icons';

describe('Icons', () => {
  describe('EraseIcon', () => {
    it('正しくレンダリングされること', () => {
      const { container } = render(<EraseIcon />);
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelector('title')?.textContent).toBe('Erase');
      expect(container.querySelector('path')).toBeTruthy();
    });

    it('propsが正しく適用されること', () => {
      const { container } = render(<EraseIcon className="test-class" />);
      expect(container.querySelector('.test-class')).toBeTruthy();
    });
  });

  describe('GoogleDriveIcon', () => {
    it('正しくレンダリングされること', () => {
      const { container } = render(<GoogleDriveIcon />);
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelector('title')?.textContent).toBe(
        'Google Drive',
      );
      expect(container.querySelectorAll('path')).toHaveLength(6);
    });

    it('propsが正しく適用されること', () => {
      const { container } = render(<GoogleDriveIcon className="test-class" />);
      expect(container.querySelector('.test-class')).toBeTruthy();
    });
  });
});
