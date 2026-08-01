import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

interface AvatarProps {
  uri?: string | null;
  displayName?: string | null;
  username?: string | null;
  size?: number;
  dimmed?: boolean;
}

export function Avatar({ uri, displayName, username, size = 40, dimmed = false }: AvatarProps) {
  const { palette } = useTheme();
  const initial = (displayName || username || '?').trim().charAt(0).toUpperCase() || '?';
  const frame = { width: size, height: size, borderRadius: size / 2, opacity: dimmed ? 0.5 : 1 };
  if (uri) {
    return <Image accessibilityLabel={`${displayName || username || 'User'} avatar`} source={{ uri }} style={frame} />;
  }
  return (
    <View style={[styles.fallback, frame, { backgroundColor: `${palette.accent}2a` }]}>
      <Text style={{ color: palette.accent, fontSize: Math.max(12, size * 0.38), fontWeight: '700' }}>
        {initial}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
