// Theme pair type definition
export type ThemePair = {
  id: string;
  label: string;
  light: string;
  dark: string;
};

// Available theme pairs
export const THEME_PAIRS: ThemePair[] = [
  { id: 'default', label: 'Default', light: 'vs', dark: 'vs-dark' },
  { id: 'github', label: 'GitHub', light: 'github-light', dark: 'github-dark' },
  {
    id: 'solarized',
    label: 'Solarized',
    light: 'solarized-light',
    dark: 'solarized-dark',
  },
  {
    id: 'tomorrow',
    label: 'Tomorrow',
    light: 'tomorrow',
    dark: 'tomorrow-night',
  },
  { id: 'clouds', label: 'Clouds', light: 'clouds', dark: 'clouds-midnight' },
  { id: 'monokai', label: 'Monokai', light: 'vs', dark: 'monokai' },
  { id: 'dracula', label: 'Dracula', light: 'vs', dark: 'dracula' },
  { id: 'nord', label: 'Nord', light: 'vs', dark: 'nord' },
  { id: 'night-owl', label: 'Night Owl', light: 'vs', dark: 'night-owl' },
];

// Get theme pair by id
export const getThemePair = (id: string): ThemePair => {
  return THEME_PAIRS.find((pair) => pair.id === id) || THEME_PAIRS[0];
};
