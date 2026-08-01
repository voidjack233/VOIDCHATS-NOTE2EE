import { ChevronRight, X } from 'lucide-react-native';
import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeContext';
import type { WhoOption } from '../../types/models';

export function SectionCard({
  title,
  description,
  right,
  children,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { palette } = useTheme();
  return (
    <View style={[styles.section, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <View style={styles.sectionHeading}>
        <View style={styles.sectionHeadingCopy}>
          <Text style={[styles.sectionTitle, { color: palette.text }]}>{title}</Text>
          {description ? (
            <Text style={[styles.sectionDescription, { color: palette.muted }]}>{description}</Text>
          ) : null}
        </View>
        {right}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

export function MenuRow({
  icon,
  title,
  description,
  badge,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { palette } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuRow,
        { backgroundColor: pressed ? palette.hover : palette.surface, borderColor: palette.border },
        disabled && styles.disabled,
      ]}
    >
      <View style={[styles.menuIcon, { backgroundColor: `${palette.accent}18` }]}>{icon}</View>
      <View style={styles.menuCopy}>
        <View style={styles.menuTitleRow}>
          <Text style={[styles.menuTitle, { color: palette.text }]}>{title}</Text>
          {badge ? (
            <View style={[styles.badge, { backgroundColor: palette.hover }]}>
              <Text style={[styles.badgeText, { color: palette.muted }]}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.menuDescription, { color: palette.muted }]}>{description}</Text>
      </View>
      <ChevronRight color={palette.faint} size={19} />
    </Pressable>
  );
}

export function ActionRow({
  icon,
  label,
  detail,
  danger = false,
  disabled = false,
  loading = false,
  onPress,
}: {
  icon?: ReactNode;
  label: string;
  detail?: string;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  const { palette } = useTheme();
  const color = danger ? palette.danger : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        { backgroundColor: pressed ? palette.hover : 'transparent' },
        (disabled || loading) && styles.disabled,
      ]}
    >
      {icon}
      <View style={styles.actionCopy}>
        <Text style={[styles.actionLabel, { color }]}>{label}</Text>
        {detail ? <Text style={[styles.actionDetail, { color: palette.muted }]}>{detail}</Text> : null}
      </View>
      {loading ? <ActivityIndicator color={color} size="small" /> : null}
    </Pressable>
  );
}

export function SwitchRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { palette } = useTheme();
  return (
    <View style={[styles.controlRow, { borderBottomColor: palette.border }]}>
      <Text style={[styles.controlLabel, { color: palette.text }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        ios_backgroundColor={palette.hover}
        onValueChange={onChange}
        thumbColor="#ffffff"
        trackColor={{ false: palette.hover, true: palette.accent }}
        value={value}
      />
    </View>
  );
}

const whoOptions: Array<{ label: string; value: WhoOption }> = [
  { label: 'Everyone', value: 'everyone' },
  { label: 'Admins', value: 'admins' },
  { label: 'Owner', value: 'owner' },
];

export function WhoChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: WhoOption;
  onChange: (value: WhoOption) => void;
}) {
  const { palette } = useTheme();
  return (
    <View style={[styles.whoRow, { borderBottomColor: palette.border }]}>
      <Text style={[styles.controlLabel, { color: palette.text }]}>{label}</Text>
      <View style={styles.choiceGroup}>
        {whoOptions.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={option.value}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [
                styles.choice,
                {
                  backgroundColor: selected ? `${palette.accent}24` : palette.surfaceRaised,
                  borderColor: selected ? palette.accent : palette.border,
                  opacity: pressed ? 0.78 : 1,
                },
              ]}
            >
              <Text style={[styles.choiceText, { color: selected ? palette.accent : palette.muted }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const { palette } = useTheme();
  const normalized = role === 'owner' || role === 'admin' || role === 'viewer' ? role : 'member';
  const color = normalized === 'owner'
    ? palette.warning
    : normalized === 'admin'
      ? palette.accent
      : normalized === 'viewer'
        ? palette.faint
        : palette.success;
  const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return (
    <View style={[styles.roleBadge, { backgroundColor: `${color}20`, borderColor: `${color}44` }]}>
      <Text style={[styles.roleText, { color }]}>{label}</Text>
    </View>
  );
}

export function BottomSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="Close sheet" onPress={onClose} style={[styles.backdrop, { backgroundColor: palette.overlay }]} />
        <View style={[
          styles.sheet,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
            paddingBottom: Math.max(18, insets.bottom + 10),
          },
        ]}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: palette.text }]}>{title}</Text>
            <Pressable accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={styles.close}>
              <X color={palette.muted} size={20} />
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  sectionHeading: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, padding: 16, paddingBottom: 10 },
  sectionHeadingCopy: { flex: 1 },
  sectionTitle: { fontSize: 15, fontWeight: '800' },
  sectionDescription: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  sectionBody: { paddingBottom: 6 },
  menuRow: { alignItems: 'center', borderRadius: 15, borderWidth: 1, flexDirection: 'row', gap: 12, padding: 14 },
  menuIcon: { alignItems: 'center', borderRadius: 12, height: 42, justifyContent: 'center', width: 42 },
  menuCopy: { flex: 1, minWidth: 0 },
  menuTitleRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  menuTitle: { fontSize: 15, fontWeight: '700' },
  menuDescription: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  badge: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  disabled: { opacity: 0.48 },
  actionRow: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 11, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10 },
  actionCopy: { flex: 1 },
  actionLabel: { fontSize: 14, fontWeight: '600' },
  actionDetail: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  controlRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, minHeight: 58, paddingHorizontal: 16, paddingVertical: 9 },
  controlLabel: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  whoRow: { borderBottomWidth: StyleSheet.hairlineWidth, gap: 10, paddingHorizontal: 16, paddingVertical: 13 },
  choiceGroup: { flexDirection: 'row', gap: 7 },
  choice: { alignItems: 'center', borderRadius: 9, borderWidth: 1, flex: 1, minHeight: 34, justifyContent: 'center', paddingHorizontal: 7 },
  choiceText: { fontSize: 11, fontWeight: '700' },
  roleBadge: { borderRadius: 9, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  roleText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, maxHeight: '88%', paddingHorizontal: 14, paddingTop: 10 },
  sheetHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 46, paddingHorizontal: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '800' },
  close: { padding: 7 },
});
