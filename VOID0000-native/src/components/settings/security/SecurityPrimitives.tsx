import { ChevronRight } from 'lucide-react-native';
import React, { PropsWithChildren, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../theme/ThemeContext';

export function SecuritySection({
  title,
  children,
  tone = 'default',
}: PropsWithChildren<{ title: string; tone?: 'default' | 'danger' }>) {
  const { palette } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[
        styles.sectionTitle,
        { color: tone === 'danger' ? palette.danger : palette.muted },
      ]}>
        {title}
      </Text>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );
}

export function SecurityCard({
  children,
  style,
}: PropsWithChildren<{ style?: object }>) {
  const { palette } = useTheme();
  return (
    <View style={[
      styles.card,
      { backgroundColor: palette.surface, borderColor: palette.border },
      style,
    ]}>
      {children}
    </View>
  );
}

export function ReadOnlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  const { palette } = useTheme();
  return (
    <View>
      <Text style={[styles.fieldLabel, { color: palette.text }]}>{label}</Text>
      <View style={[
        styles.fieldValue,
        { backgroundColor: palette.bg, borderColor: palette.border },
      ]}>
        <Text numberOfLines={1} style={[styles.fieldValueText, { color: palette.text }]}>
          {value}
        </Text>
      </View>
      <Text style={[styles.fieldHint, { color: palette.muted }]}>{hint}</Text>
    </View>
  );
}

export function SecurityRow({
  title,
  description,
  icon,
  onPress,
  trailing,
  disabled = false,
  tone = 'default',
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  onPress?: () => void;
  trailing?: ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'danger' | 'warning';
}) {
  const { palette } = useTheme();
  const titleColor = tone === 'danger'
    ? palette.danger
    : tone === 'warning'
      ? palette.warning
      : palette.text;

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: palette.surface, borderColor: palette.border },
        (disabled || !onPress) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {icon ? (
        <View style={[styles.icon, { backgroundColor: palette.hover }]}>{icon}</View>
      ) : null}
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: titleColor }]}>{title}</Text>
        {description ? (
          <Text style={[styles.rowDescription, { color: palette.muted }]}>{description}</Text>
        ) : null}
      </View>
      {trailing || (onPress ? <ChevronRight color={palette.faint} size={19} /> : null)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  sectionContent: { gap: 10 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16 },
  fieldLabel: { fontSize: 14, fontWeight: '700', marginBottom: 7 },
  fieldValue: { borderRadius: 11, borderWidth: 1, minHeight: 48, justifyContent: 'center', paddingHorizontal: 14 },
  fieldValueText: { fontSize: 14, fontWeight: '500' },
  fieldHint: { fontSize: 12, marginTop: 6 },
  row: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 68,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  disabled: { opacity: 0.62 },
  pressed: { opacity: 0.78 },
  icon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  rowDescription: { fontSize: 12, lineHeight: 17, marginTop: 3 },
});
