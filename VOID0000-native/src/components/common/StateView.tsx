import { AlertTriangle, Inbox, WifiOff } from 'lucide-react-native';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import { Button } from './Button';

interface StateViewProps {
  type?: 'loading' | 'empty' | 'error' | 'offline';
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

export function StateView({
  type = 'empty',
  title,
  message,
  actionLabel,
  onAction,
  compact = false,
}: StateViewProps) {
  const { palette } = useTheme();
  const icon = type === 'loading'
    ? <ActivityIndicator size="large" color={palette.accent} />
    : type === 'error'
      ? <AlertTriangle size={compact ? 28 : 40} color={palette.danger} />
      : type === 'offline'
        ? <WifiOff size={compact ? 28 : 40} color={palette.muted} />
        : <Inbox size={compact ? 28 : 40} color={palette.muted} />;
  return (
    <View style={[styles.container, compact && styles.compact]}>
      {icon}
      <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
      {message ? <Text style={[styles.message, { color: palette.muted }]}>{message}</Text> : null}
      {actionLabel && onAction ? (
        <Button compact onPress={onAction} style={styles.action}>{actionLabel}</Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 28 },
  compact: { flex: 0, paddingVertical: 32 },
  title: { fontSize: 16, fontWeight: '700', marginTop: 14, textAlign: 'center' },
  message: { fontSize: 13, lineHeight: 20, marginTop: 6, maxWidth: 300, textAlign: 'center' },
  action: { marginTop: 18 },
});
