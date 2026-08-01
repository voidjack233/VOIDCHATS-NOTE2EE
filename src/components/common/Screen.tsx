import React, { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeContext';

interface ScreenProps {
  style?: StyleProp<ViewStyle>;
  keyboard?: boolean;
  edges?: Array<'top' | 'right' | 'bottom' | 'left'>;
}

export function Screen({
  children,
  style,
  keyboard = false,
  edges = ['top', 'right', 'bottom', 'left'],
}: PropsWithChildren<ScreenProps>) {
  const { palette } = useTheme();
  const content = (
    <SafeAreaView edges={edges} style={[styles.safe, { backgroundColor: palette.bg }, style]}>
      {children}
    </SafeAreaView>
  );
  if (!keyboard) return content;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.safe}
    >
      {content}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ safe: { flex: 1 } });
