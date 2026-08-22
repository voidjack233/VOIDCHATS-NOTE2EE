import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';
import type { PresenceStatus } from '../../types/models';

export function PresenceDot({ status, size = 12 }: { status: PresenceStatus; size?: number }) {
  const { palette } = useTheme();
  const color = status === 'online'
    ? '#22c55e'
    : status === 'idle'
      ? '#eab308'
      : status === 'dnd' ? '#ef4444' : '#6b7280';
  return (
    <View style={[
      styles.dot,
      {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderColor: palette.surface,
      },
    ]} />
  );
}

const styles = StyleSheet.create({ dot: { borderWidth: 2 } });
