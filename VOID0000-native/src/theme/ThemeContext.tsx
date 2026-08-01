import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { apiJson } from '../services/api';

export type ThemeName = 'void' | 'ocean' | 'forest' | 'sunset' | 'midnight';
export type Density = 'compact' | 'comfortable';
export type MessageSpacing = 0 | 4 | 8 | 16 | 24;
export type ChatFontScale = 12 | 14 | 15 | 16 | 18 | 20 | 24;

interface ThemePreset {
  accent: string;
  bg: string;
  text: string;
  hover: string;
}

export const THEME_PRESETS: Record<ThemeName, ThemePreset> = {
  void: { accent: '#6366f1', bg: '#111827', text: '#f3f4f6', hover: '#374151' },
  ocean: { accent: '#0ea5e9', bg: '#0f172a', text: '#f8fafc', hover: '#334155' },
  forest: { accent: '#10b981', bg: '#0c1f1c', text: '#ecfdf5', hover: '#2d4a43' },
  sunset: { accent: '#f97316', bg: '#1e1b2e', text: '#fff7ed', hover: '#3f3b5c' },
  midnight: { accent: '#8b5cf6', bg: '#030712', text: '#f5f3ff', hover: '#1f2937' },
};

const STORAGE_KEY = 'void_native_preferences';
const NOTIFICATION_STORAGE_KEY = 'void_native_message_sounds';
const MESSAGE_SPACING_VALUES: MessageSpacing[] = [0, 4, 8, 16, 24];
const CHAT_FONT_SCALE_VALUES: ChatFontScale[] = [12, 14, 15, 16, 18, 20, 24];

const adjustColor = (hex: string, amount: number) => {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  if (!Number.isFinite(value) || normalized.length !== 6) return hex;
  const channel = (shift: number) => Math.max(0, Math.min(255, ((value >> shift) & 0xff) + amount));
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')}`;
};

export interface Palette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  hover: string;
  accent: string;
  accentHover: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  danger: string;
  warning: string;
  success: string;
  overlay: string;
}

interface StoredPreferences {
  theme: ThemeName;
  density: Density;
  messageSpacing: MessageSpacing;
  chatFontScale: ChatFontScale;
  messageNotificationsEnabled: boolean;
}

interface ThemeContextValue extends StoredPreferences {
  palette: Palette;
  loading: boolean;
  hasChanges: boolean;
  setTheme: (theme: ThemeName) => void;
  setDensity: (density: Density) => void;
  setMessageSpacing: (spacing: MessageSpacing) => void;
  setChatFontScale: (scale: ChatFontScale) => void;
  setMessageNotificationsEnabled: (enabled: boolean) => void;
  savePreferences: () => Promise<void>;
  saveNotificationPreference: () => Promise<void>;
  loadRemotePreferences: () => Promise<void>;
  resetToDefaults: () => void;
}

const defaults: StoredPreferences = {
  theme: 'void',
  density: 'compact',
  messageSpacing: 8,
  chatFontScale: 16,
  messageNotificationsEnabled: true,
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const isThemeName = (value: unknown): value is ThemeName =>
  typeof value === 'string' && value in THEME_PRESETS;

const sanitizePreferences = (
  input: Partial<StoredPreferences>,
  fallback: StoredPreferences = defaults,
): StoredPreferences => ({
  theme: isThemeName(input.theme) ? input.theme : fallback.theme,
  density: input.density === 'compact' || input.density === 'comfortable'
    ? input.density
    : fallback.density,
  messageSpacing: MESSAGE_SPACING_VALUES.includes(input.messageSpacing as MessageSpacing)
    ? input.messageSpacing as MessageSpacing
    : fallback.messageSpacing,
  chatFontScale: CHAT_FONT_SCALE_VALUES.includes(input.chatFontScale as ChatFontScale)
    ? input.chatFontScale as ChatFontScale
    : fallback.chatFontScale,
  messageNotificationsEnabled: typeof input.messageNotificationsEnabled === 'boolean'
    ? input.messageNotificationsEnabled
    : fallback.messageNotificationsEnabled,
});

export function ThemeProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState<StoredPreferences>(defaults);
  const [saved, setSaved] = useState<StoredPreferences>(defaults);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void AsyncStorage.multiGet([STORAGE_KEY, NOTIFICATION_STORAGE_KEY])
      .then((entries) => {
        if (!active) return;
        const rawPreferences = entries[0]?.[1];
        const rawSoundPreference = entries[1]?.[1];
        const parsed = rawPreferences
          ? JSON.parse(rawPreferences) as Partial<StoredPreferences>
          : {};
        const next = sanitizePreferences(parsed);
        if (rawSoundPreference === 'true' || rawSoundPreference === 'false') {
          next.messageNotificationsEnabled = rawSoundPreference === 'true';
        }
        setPreferences(next);
        setSaved(next);
      })
      .catch(() => undefined)
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback(<K extends keyof StoredPreferences>(key: K, value: StoredPreferences[K]) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  }, []);

  const savePreferences = useCallback(async () => {
    const preset = THEME_PRESETS[preferences.theme];
    await apiJson('/api/users/preferences', {
      method: 'PUT',
      body: JSON.stringify({
        accent_color: preset.accent,
        bg_color: preset.bg,
        text_color: preset.text,
        hover_color: preset.hover,
        theme: preferences.theme,
        density: preferences.density,
        message_group_spacing: preferences.messageSpacing,
        chat_font_scale: preferences.chatFontScale,
      }),
    });
    const nextSaved = {
      ...preferences,
      messageNotificationsEnabled: saved.messageNotificationsEnabled,
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextSaved));
    setSaved(nextSaved);
  }, [preferences, saved.messageNotificationsEnabled]);

  const saveNotificationPreference = useCallback(async () => {
    await AsyncStorage.setItem(
      NOTIFICATION_STORAGE_KEY,
      String(preferences.messageNotificationsEnabled),
    );
    setSaved((current) => ({
      ...current,
      messageNotificationsEnabled: preferences.messageNotificationsEnabled,
    }));
  }, [preferences.messageNotificationsEnabled]);

  const loadRemotePreferences = useCallback(async () => {
    try {
      const data = await apiJson<{
        success?: boolean;
        preferences?: Record<string, unknown>;
      }>('/api/users/preferences');
      if (!data.success || !data.preferences) return;
      const remote = data.preferences;
      setPreferences((current) => {
        const next: StoredPreferences = {
          theme: isThemeName(remote.theme) ? remote.theme : current.theme,
          density: remote.density === 'comfortable' ? 'comfortable' : 'compact',
          messageSpacing: MESSAGE_SPACING_VALUES.includes(Number(remote.message_group_spacing) as MessageSpacing)
            ? Number(remote.message_group_spacing) as MessageSpacing
            : current.messageSpacing,
          chatFontScale: CHAT_FONT_SCALE_VALUES.includes(Number(remote.chat_font_scale) as ChatFontScale)
            ? Number(remote.chat_font_scale) as ChatFontScale
            : current.chatFontScale,
          messageNotificationsEnabled: current.messageNotificationsEnabled,
        };
        setSaved((currentSaved) => ({
          ...next,
          messageNotificationsEnabled: currentSaved.messageNotificationsEnabled,
        }));
        void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    } catch {
      // Local preferences remain the offline source of truth.
    }
  }, []);

  const palette = useMemo<Palette>(() => {
    const preset = THEME_PRESETS[preferences.theme];
    return {
      bg: preset.bg,
      surface: adjustColor(preset.bg, 10),
      surfaceRaised: adjustColor(preset.bg, 18),
      hover: preset.hover,
      accent: preset.accent,
      accentHover: adjustColor(preset.accent, -20),
      text: preset.text,
      muted: '#9ca3af',
      faint: '#6b7280',
      border: adjustColor(preset.bg, 30),
      danger: '#f87171',
      warning: '#fbbf24',
      success: '#34d399',
      overlay: 'rgba(0,0,0,0.68)',
    };
  }, [preferences.theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    ...preferences,
    palette,
    loading,
    hasChanges: preferences.theme !== saved.theme ||
      preferences.density !== saved.density ||
      preferences.messageSpacing !== saved.messageSpacing ||
      preferences.chatFontScale !== saved.chatFontScale,
    setTheme: (theme) => update('theme', theme),
    setDensity: (density) => update('density', density),
    setMessageSpacing: (spacing) => update('messageSpacing', spacing),
    setChatFontScale: (scale) => update('chatFontScale', scale),
    setMessageNotificationsEnabled: (enabled) => update('messageNotificationsEnabled', enabled),
    savePreferences,
    saveNotificationPreference,
    loadRemotePreferences,
    resetToDefaults: () => setPreferences(defaults),
  }), [loading, palette, preferences, saved, saveNotificationPreference, savePreferences, loadRemotePreferences, update]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
