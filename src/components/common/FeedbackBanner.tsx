import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

export function FeedbackBanner({
  message,
  kind = 'error',
  onDismiss,
}: {
  message: string;
  kind?: 'error' | 'success' | 'info' | 'warning';
  onDismiss?: () => void;
}) {
  const { palette } = useTheme();
  const color = kind === 'success' ? palette.success : kind === 'info' ? palette.accent : kind === 'warning' ? palette.warning : palette.danger;
  const Icon = kind === 'success' ? CheckCircle2 : kind === 'info' ? Info : AlertTriangle;
  return (
    <View style={[styles.banner, { borderColor: `${color}55`, backgroundColor: `${color}16` }]}>
      <Icon color={color} size={18} />
      <Text style={[styles.message, { color: palette.text }]}>{message}</Text>
      {onDismiss ? (
        <Pressable accessibilityLabel="Dismiss notice" hitSlop={10} onPress={onDismiss}>
          <X color={palette.muted} size={17} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { alignItems: 'flex-start', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10, padding: 12 },
  message: { flex: 1, fontSize: 13, lineHeight: 19 },
});
