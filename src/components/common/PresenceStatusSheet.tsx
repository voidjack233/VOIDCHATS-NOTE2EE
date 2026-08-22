import { Check, X } from 'lucide-react-native';
import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  PRESENCE_MODE_OPTIONS,
  type PresenceMode,
  type PresenceStatus,
} from '../../features/presence/presenceStatus';
import { useTheme } from '../../theme/ThemeContext';
import { PresenceDot } from './PresenceDot';

interface PresenceStatusSheetProps {
  visible: boolean;
  mode: PresenceMode;
  ownStatus: PresenceStatus;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (mode: PresenceMode) => void;
}

export function PresenceStatusSheet({
  visible,
  mode,
  ownStatus,
  busy,
  error,
  onClose,
  onSelect,
}: PresenceStatusSheetProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close active status picker"
          onPress={onClose}
          style={[styles.backdrop, { backgroundColor: palette.overlay }]}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surface,
              borderColor: palette.border,
              paddingBottom: Math.max(18, insets.bottom + 10),
            },
          ]}
        >
          <View style={styles.header}>
            <View>
              <Text style={[styles.title, { color: palette.text }]}>Active status</Text>
              <Text style={[styles.subtitle, { color: palette.muted }]}>Choose how others see you</Text>
            </View>
            <Pressable accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={styles.close}>
              <X color={palette.muted} size={20} />
            </Pressable>
          </View>

          <View style={styles.options}>
            {PRESENCE_MODE_OPTIONS.map((option) => {
              const selected = option.mode === mode;
              const status = option.publicStatus ?? (mode === 'online' ? ownStatus : 'online');
              return (
                <Pressable
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy }}
                  disabled={busy}
                  key={option.mode}
                  onPress={() => onSelect(option.mode)}
                  style={({ pressed }) => [
                    styles.option,
                    {
                      backgroundColor: selected
                        ? `${palette.accent}1f`
                        : pressed ? palette.hover : 'transparent',
                      borderColor: selected ? `${palette.accent}55` : 'transparent',
                    },
                    busy && styles.disabled,
                  ]}
                >
                  <View style={styles.dotFrame}>
                    <PresenceDot size={14} status={status} />
                  </View>
                  <View style={styles.copy}>
                    <Text style={[styles.label, { color: palette.text }]}>{option.label}</Text>
                    <Text style={[styles.description, { color: palette.muted }]}>{option.description}</Text>
                  </View>
                  {selected ? <Check color={palette.accent} size={19} /> : null}
                </Pressable>
              );
            })}
          </View>

          {busy ? (
            <View style={styles.feedback}>
              <ActivityIndicator color={palette.accent} size="small" />
              <Text style={[styles.feedbackText, { color: palette.muted }]}>Saving status...</Text>
            </View>
          ) : null}
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 54,
    paddingHorizontal: 5,
  },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 11, marginTop: 3 },
  close: { padding: 7 },
  options: { gap: 3, marginTop: 6 },
  option: {
    alignItems: 'center',
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  disabled: { opacity: 0.58 },
  dotFrame: { alignItems: 'center', justifyContent: 'center', width: 30 },
  copy: { flex: 1, marginHorizontal: 7, minWidth: 0 },
  label: { fontSize: 14, fontWeight: '700' },
  description: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  feedback: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  feedbackText: { fontSize: 12, fontWeight: '600' },
  error: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingTop: 10 },
});
