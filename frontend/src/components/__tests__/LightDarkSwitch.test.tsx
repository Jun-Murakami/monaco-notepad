import { createTheme, ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LightDarkSwitch } from '../LightDarkSwitch';

describe('LightDarkSwitch', () => {
  const renderWithTheme = (mode: 'light' | 'dark') => {
    const theme = createTheme({
      palette: {
        mode,
        primary: {
          main: '#1976d2',
          light: '#42a5f5',
        },
        background: {
          default: '#ffffff',
        },
      },
    });

    return render(
      <ThemeProvider theme={theme}>
        <LightDarkSwitch data-testid="theme-switch" />
      </ThemeProvider>,
    );
  };

  it('ライトモードで正しくレンダリングされること', () => {
    const { container } = renderWithTheme('light');
    const switchElement = screen.getByTestId('theme-switch');

    // スイッチが存在することを確認
    expect(switchElement).toBeDefined();

    // 必要なコンポーネントが存在することを確認
    expect(container.querySelector('.MuiSwitch-thumb')).toBeDefined();
    expect(container.querySelector('.MuiSwitch-track')).toBeDefined();
    expect(container.querySelector('.MuiSwitch-switchBase')).toBeDefined();
  });

  it('ダークモードで正しくレンダリングされること', () => {
    const { container } = renderWithTheme('dark');
    const switchElement = screen.getByTestId('theme-switch');

    // スイッチが存在することを確認
    expect(switchElement).toBeDefined();

    // 必要なコンポーネントが存在することを確認
    expect(container.querySelector('.MuiSwitch-thumb')).toBeDefined();
    expect(container.querySelector('.MuiSwitch-track')).toBeDefined();
    expect(container.querySelector('.MuiSwitch-switchBase')).toBeDefined();
  });

  it('propsが正しく適用されること', () => {
    const { container } = render(
      <ThemeProvider theme={createTheme()}>
        <LightDarkSwitch checked disabled className="custom-class" />
      </ThemeProvider>,
    );

    const switchElement = container.querySelector('.MuiSwitch-root');
    expect(switchElement?.classList.contains('custom-class')).toBe(true);

    const input = switchElement?.querySelector('input');
    expect(input?.disabled).toBe(true);
    expect(input?.checked).toBe(true);
  });
});
