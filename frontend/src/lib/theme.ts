import { createTheme } from '@mui/material';

// プライマリカラーの補色を計算する
const getComplementaryColor = (hex: string): string => {
  // hex → RGB
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;

  // RGB → HSL
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  // 色相を180°回転し、彩度を抑える
  h = (h + 0.5) % 1;
  s *= 0.95;

  // HSL → RGB
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  let r2: number;
  let g2: number;
  let b2: number;
  if (s === 0) {
    r2 = g2 = b2 = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r2 = hue2rgb(p, q, h + 1 / 3);
    g2 = hue2rgb(p, q, h);
    b2 = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (v: number): string => {
    const hex = Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
    return hex;
  };

  return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
};

const LIGHT_PRIMARY = '#00c1d9';
const DARK_PRIMARY = '#01afc6';
const LIGHT_SECONDARY = getComplementaryColor(LIGHT_PRIMARY);
const DARK_SECONDARY = getComplementaryColor(DARK_PRIMARY);

export const lightTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: LIGHT_PRIMARY,
    },
    secondary: {
      main: LIGHT_SECONDARY,
    },
    error: {
      main: '#d91900',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': {
          '--focus-border': LIGHT_PRIMARY,
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
  },
});

export const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: DARK_PRIMARY,
    },
    secondary: {
      main: DARK_SECONDARY,
    },
    error: {
      main: '#c95023',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': {
          '--focus-border': DARK_PRIMARY,
        },
        body: { backgroundColor: '#121212' },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
  },
});
