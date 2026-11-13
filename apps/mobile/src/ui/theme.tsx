import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palettes, parseTheme, THEME_STORAGE_KEY, type ThemeColors, type ThemeMode } from './palette';

type ThemeValue = { colors: ThemeColors; mode: ThemeMode; setMode: (mode: ThemeMode) => void };
const ThemeContext = createContext<ThemeValue | null>(null);
let writes = Promise.resolve();
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [choice, setChoice] = useState<ThemeMode | null>(null);
  const [restored, setRestored] = useState(false);
  const mode = choice ?? (system === 'light' ? 'light' : 'dark');
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(THEME_STORAGE_KEY).then(value => {
      if (active) { setChoice(current => current ?? parseTheme(value)); setRestored(true); }
    }).catch(() => { if (active) setRestored(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!restored || !choice) return;
    writes = writes.catch(() => {}).then(() => AsyncStorage.setItem(THEME_STORAGE_KEY, choice));
    // A storage refusal must not prevent theme changes for the current session.
    void writes.catch(() => {});
  }, [choice, restored]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    root.dataset.orbitTheme = mode;
    root.style.colorScheme = mode;
    root.style.backgroundColor = palettes[mode].bg;
  }, [mode]);
  return <ThemeContext.Provider value={{ colors: palettes[mode], mode, setMode: setChoice }}>{children}</ThemeContext.Provider>;
}
export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required.');
  return value;
}
