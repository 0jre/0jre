export type ThemeMode = 'light' | 'dark';

// Semantic TUFFUI tokens shared with the native renderer.
export const palettes = {
  light: {
    bg: '#ffffff', card: '#f5f6f8', raised: '#eceef2', line: '#dde1e7',
    ink: '#101318', muted: '#596271', lime: '#101318', brand: '#101318',
    onBrand: '#ffffff', green: '#107036', red: '#c5283d',
    positiveTint: '#e6f5ec', negativeTint: '#fce9ed', overlay: '#00000080',
  },
  dark: {
    bg: '#070a10', card: '#101722', raised: '#192334', line: '#283548',
    ink: '#f7f9fc', muted: '#a0aec0', lime: '#246ce0', brand: '#246ce0',
    onBrand: '#ffffff', green: '#4ade80', red: '#ff7185',
    positiveTint: '#102d22', negativeTint: '#351922', overlay: '#000000b3',
  },
} as const;
export type ThemeColors = { [K in keyof typeof palettes.light]: string };
export const THEME_STORAGE_KEY = 'orbit.theme.v1';
export function parseTheme(value: string | null): ThemeMode | null {
  return value === 'light' || value === 'dark' ? value : null;
}
