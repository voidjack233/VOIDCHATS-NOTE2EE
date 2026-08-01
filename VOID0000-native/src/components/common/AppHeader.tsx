import { ArrowLeft } from 'lucide-react-native';
import React, { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

interface AppHeaderProps {
  title: string;
  subtitle?: string | null;
  onBack?: () => void;
  left?: ReactNode;
  right?: ReactNode;
}

export function AppHeader({ title, subtitle, onBack, left, right }: AppHeaderProps) {
  const { palette } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: palette.surface, borderBottomColor: palette.border }]}>
      <View style={styles.left}>
        {onBack ? (
          <Pressable accessibilityLabel="Back" accessibilityRole="button" hitSlop={10} onPress={onBack} style={styles.back}>
            <ArrowLeft size={21} color={palette.muted} />
          </Pressable>
        ) : left}
        <View style={styles.titles}>
          <Text numberOfLines={1} style={[styles.title, { color: palette.text }]}>{title}</Text>
          {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, { color: palette.muted }]}>{subtitle}</Text> : null}
        </View>
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 64,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  left: { alignItems: 'center', flex: 1, flexDirection: 'row', minWidth: 0 },
  back: { marginLeft: -6, marginRight: 8, padding: 6 },
  titles: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, fontWeight: '700' },
  subtitle: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  right: { marginLeft: 10 },
});
