import React, { PropsWithChildren } from 'react';
import {
  ActivityIndicator,
  Pressable,
  PressableProps,
  StyleProp,
  StyleSheet,
  Text,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

interface ButtonProps extends Omit<PressableProps, 'style'> {
  variant?: ButtonVariant;
  loading?: boolean;
  fullWidth?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  children,
  variant = 'primary',
  loading = false,
  fullWidth = false,
  compact = false,
  disabled,
  style,
  ...props
}: PropsWithChildren<ButtonProps>) {
  const { palette } = useTheme();
  const colors: Record<ButtonVariant, { background: string; foreground: string; border: string }> = {
    primary: { background: palette.accent, foreground: '#ffffff', border: palette.accent },
    secondary: { background: palette.hover, foreground: palette.text, border: palette.border },
    danger: { background: '#dc2626', foreground: '#ffffff', border: '#dc2626' },
    ghost: { background: 'transparent', foreground: palette.muted, border: 'transparent' },
    success: { background: '#059669', foreground: '#ffffff', border: '#059669' },
  };
  const color = colors[variant];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.regular,
        fullWidth && styles.fullWidth,
        {
          backgroundColor: color.background,
          borderColor: color.border,
          opacity: isDisabled ? 0.48 : pressed ? 0.8 : 1,
        },
        style,
      ]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator size="small" color={color.foreground} />
      ) : typeof children === 'string' ? (
        <Text style={[styles.label, { color: color.foreground }]}>{children}</Text>
      ) : children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
  },
  regular: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  compact: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  fullWidth: { width: '100%' },
  label: { fontSize: 15, fontWeight: '700' },
});
