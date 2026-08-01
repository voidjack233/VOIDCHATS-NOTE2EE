import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Check, RotateCcw, Save } from 'lucide-react-native';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import type { RootStackParamList } from '../../navigation/types';
import {
  type ChatFontScale,
  type Density,
  type MessageSpacing,
  THEME_PRESETS,
  type ThemeName,
  useTheme,
} from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'AppearanceSettings'>;

const themes: Array<{ label: string; value: ThemeName }> = [
  { label: 'Void', value: 'void' },
  { label: 'Ocean', value: 'ocean' },
  { label: 'Forest', value: 'forest' },
  { label: 'Sunset', value: 'sunset' },
  { label: 'Midnight', value: 'midnight' },
];
const spacingOptions: MessageSpacing[] = [0, 4, 8, 16, 24];
const fontOptions: ChatFontScale[] = [12, 14, 15, 16, 18, 20, 24];

interface ChoiceProps<T extends string | number> {
  label: string;
  onPress: () => void;
  selected: boolean;
  value: T;
}

export function AppearanceScreen({ navigation }: Props) {
  const theme = useTheme();
  const {
    palette,
    density,
    messageSpacing,
    chatFontScale,
    hasChanges,
    savePreferences,
    setChatFontScale,
    setDensity,
    setMessageSpacing,
    setTheme,
  } = theme;
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await savePreferences();
      setFeedback({ kind: 'success', message: 'Appearance preferences saved.' });
    } catch (caught) {
      setFeedback({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Failed to save appearance preferences.',
      });
    } finally {
      setSaving(false);
    }
  };

  const resetAppearance = () => {
    setTheme('void');
    setDensity('compact');
    setMessageSpacing(8);
    setChatFontScale(16);
    setFeedback(null);
  };

  const Choice = <T extends string | number>({ label, onPress, selected }: ChoiceProps<T>) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: selected ? `${palette.accent}24` : pressed ? palette.hover : palette.surfaceRaised,
          borderColor: selected ? palette.accent : palette.border,
        },
      ]}
    >
      <Text style={[styles.choiceLabel, { color: selected ? palette.accent : palette.text }]}>{label}</Text>
    </Pressable>
  );

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} subtitle="Changes preview instantly" title="Appearance" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {feedback ? (
          <FeedbackBanner
            kind={feedback.kind}
            message={feedback.message}
            onDismiss={() => setFeedback(null)}
          />
        ) : null}

        <Section description="Choose the color family used throughout VOID0000." title="Theme">
          <View style={styles.themeGrid}>
            {themes.map((option) => {
              const preset = THEME_PRESETS[option.value];
              const selected = theme.theme === option.value;
              return (
                <Pressable
                  accessibilityLabel={`${option.label} theme`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={option.value}
                  onPress={() => setTheme(option.value)}
                  style={({ pressed }) => [
                    styles.themeCard,
                    {
                      backgroundColor: preset.bg,
                      borderColor: selected ? preset.accent : `${preset.text}2b`,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <View style={styles.themeTopRow}>
                    <View style={[styles.colorDot, { backgroundColor: preset.accent }]} />
                    {selected ? <Check color={preset.accent} size={17} /> : null}
                  </View>
                  <Text style={[styles.themeName, { color: preset.text }]}>{option.label}</Text>
                  <View style={styles.swatches}>
                    <View style={[styles.swatch, { backgroundColor: preset.hover }]} />
                    <View style={[styles.swatch, { backgroundColor: preset.text }]} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section description="Adjust the amount of information shown in controls and lists." title="Interface density">
          <View style={styles.choiceRow}>
            {(['compact', 'comfortable'] as Density[]).map((option) => (
              <Choice
                key={option}
                label={option === 'compact' ? 'Compact' : 'Comfortable'}
                onPress={() => setDensity(option)}
                selected={density === option}
                value={option}
              />
            ))}
          </View>
        </Section>

        <Section description="Set the vertical gap between message groups." title="Message spacing">
          <View style={styles.choiceWrap}>
            {spacingOptions.map((option) => (
              <Choice
                key={option}
                label={option === 8 ? `${option}px · Default` : `${option}px`}
                onPress={() => setMessageSpacing(option)}
                selected={messageSpacing === option}
                value={option}
              />
            ))}
          </View>
        </Section>

        <Section description="Change message text size without affecting the rest of the interface." title="Chat font size">
          <View style={styles.choiceWrap}>
            {fontOptions.map((option) => (
              <Choice
                key={option}
                label={option === 16 ? `${option}px · Default` : `${option}px`}
                onPress={() => setChatFontScale(option)}
                selected={chatFontScale === option}
                value={option}
              />
            ))}
          </View>
        </Section>

        <Section description="This sample uses your current unsaved choices." title="Live preview">
          <View style={[styles.preview, { backgroundColor: palette.bg, borderColor: palette.border }]}>
            <View style={[styles.previewHeader, { borderBottomColor: palette.border }]}>
              <View style={[styles.previewAvatar, { backgroundColor: `${palette.accent}32` }]} />
              <View>
                <Text style={[styles.previewTitle, { color: palette.text }]}>Design Room</Text>
                <Text style={[styles.previewSubtitle, { color: palette.muted }]}>3 members online</Text>
              </View>
            </View>
            <View style={[styles.previewMessages, { gap: messageSpacing }]}>
              <View style={[styles.previewBubble, { backgroundColor: palette.hover, padding: density === 'compact' ? 10 : 14 }]}>
                <Text style={[styles.previewSender, { color: palette.accent }]}>Avery</Text>
                <Text style={{ color: palette.text, fontSize: chatFontScale, lineHeight: chatFontScale * 1.35 }}>The new theme is looking good.</Text>
              </View>
              <View style={[styles.previewBubble, styles.previewBubbleMine, { backgroundColor: palette.accent, padding: density === 'compact' ? 10 : 14 }]}>
                <Text style={{ color: '#ffffff', fontSize: chatFontScale, lineHeight: chatFontScale * 1.35 }}>Everything updates live.</Text>
              </View>
            </View>
          </View>
        </Section>

        <View style={styles.actions}>
          <Button disabled={!hasChanges} fullWidth loading={saving} onPress={() => void save()}>
            <Save color="#ffffff" size={17} />
            <Text style={styles.primaryLabel}>Save Preferences</Text>
          </Button>
          <Button disabled={saving} fullWidth onPress={resetAppearance} variant="secondary">
            <RotateCcw color={palette.text} size={17} />
            <Text style={[styles.secondaryLabel, { color: palette.text }]}>Reset Appearance</Text>
          </Button>
        </View>
      </ScrollView>
    </Screen>
  );

  function Section({ children, description, title }: {
    children: React.ReactNode;
    description: string;
    title: string;
  }) {
    return (
      <View style={[styles.section, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        <Text style={[styles.sectionTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.sectionDescription, { color: palette.muted }]}>{description}</Text>
        {children}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 34 },
  section: { borderRadius: 16, borderWidth: 1, padding: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '800' },
  sectionDescription: { fontSize: 12, lineHeight: 18, marginBottom: 14, marginTop: 4 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  themeCard: { borderRadius: 13, borderWidth: 2, flexBasis: '47%', flexGrow: 1, minHeight: 102, padding: 12 },
  themeTopRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  colorDot: { borderRadius: 7, height: 14, width: 14 },
  themeName: { fontSize: 14, fontWeight: '800', marginTop: 12 },
  swatches: { flexDirection: 'row', gap: 6, marginTop: 9 },
  swatch: { borderRadius: 3, height: 7, width: 28 },
  choiceRow: { flexDirection: 'row', gap: 9 },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flexGrow: 1, justifyContent: 'center', minHeight: 44, minWidth: 78, paddingHorizontal: 11, paddingVertical: 9 },
  choiceLabel: { fontSize: 12, fontWeight: '700' },
  preview: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  previewHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 9, padding: 11 },
  previewAvatar: { borderRadius: 14, height: 28, width: 28 },
  previewTitle: { fontSize: 13, fontWeight: '800' },
  previewSubtitle: { fontSize: 10, marginTop: 1 },
  previewMessages: { padding: 12 },
  previewBubble: { alignSelf: 'flex-start', borderRadius: 12, maxWidth: '88%' },
  previewBubbleMine: { alignSelf: 'flex-end' },
  previewSender: { fontSize: 10, fontWeight: '800', marginBottom: 3 },
  actions: { gap: 9 },
  primaryLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  secondaryLabel: { fontSize: 15, fontWeight: '700' },
});
