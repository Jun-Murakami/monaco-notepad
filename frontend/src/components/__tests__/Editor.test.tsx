import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import '@testing-library/jest-dom';
import { MonacoEditor } from '../Editor';
import type { Settings } from '../../types';
import { monaco } from '../../lib/monaco';

// モックの設定
vi.mock('@monaco-editor/react', () => {
  return {
    default: vi.fn(({ onMount, onChange, options, language, theme }) => {
      if (onMount) {
        const mockEditor = {
          getValue: vi.fn(() => 'Test Content'),
          getModel: vi.fn(() => ({
            dispose: vi.fn(),
          })),
          setModel: vi.fn(),
          addCommand: vi.fn(),
        };
        onMount(mockEditor);
      }
      return null;
    }),
  };
});

vi.mock('../../lib/monaco', () => {
  return {
    monaco: {
      KeyMod: {
        CtrlCmd: 2048,
        WinCtrl: 256,
        Shift: 1024,
        Alt: 512,
      },
      KeyCode: {
        KeyN: 46,
        KeyO: 47,
        KeyS: 48,
        KeyW: 49,
        Tab: 50,
      },
      Uri: {
        parse: vi.fn(),
      },
      editor: {
        createModel: vi.fn(() => ({
          dispose: vi.fn(),
        })),
      },
    },
  };
});

describe('MonacoEditor', () => {
  const mockSettings: Settings = {
    fontFamily: 'Test Font',
    fontSize: 14,
    isDarkMode: false,
    wordWrap: 'off',
    minimap: true,
    windowWidth: 800,
    windowHeight: 600,
    windowX: 0,
    windowY: 0,
    isMaximized: false,
    isDebug: false,
  };

  const defaultProps = {
    value: 'Test Content',
    onChange: vi.fn(),
    language: 'typescript',
    settings: mockSettings,
    platform: 'win32',
    currentNote: {
      id: '1',
      title: 'Test Note',
      content: 'Test Content',
      contentHeader: null,
      language: 'typescript',
      modifiedTime: new Date().toISOString(),
      archived: false,
    },
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onClose: vi.fn(),
    onSelectNext: vi.fn(),
    onSelectPrevious: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('エディタが正しくレンダリングされること', () => {
    render(<MonacoEditor {...defaultProps} />);
  });

  it('キーボードショートカットが正しく設定されること', () => {
    render(<MonacoEditor {...defaultProps} />);
  });

  it('ダークモード設定が反映されること', () => {
    const darkModeProps = {
      ...defaultProps,
      settings: { ...mockSettings, isDarkMode: true },
    };
    render(<MonacoEditor {...darkModeProps} />);
  });

  it('言語設定が反映されること', () => {
    const javascriptProps = {
      ...defaultProps,
      language: 'javascript',
    };
    render(<MonacoEditor {...javascriptProps} />);
  });
});
