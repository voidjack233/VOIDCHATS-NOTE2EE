import React, { useEffect, useRef } from 'react';
import { NativeSyntheticEvent, StyleSheet, TextInput, TextInputKeyPressEventData, View } from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

interface OtpInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function OtpInput({ value, onChange, length = 6, disabled, autoFocus = true }: OtpInputProps) {
  const { palette } = useTheme();
  const refs = useRef<Array<TextInput | null>>([]);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => refs.current[0]?.focus(), 250);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  const applyDigits = (raw: string, index: number) => {
    const digits = raw.replace(/\D/g, '');
    const next = [...value];
    if (!digits) {
      next[index] = '';
      onChange(next);
      return;
    }
    digits.slice(0, length - index).split('').forEach((digit, offset) => {
      next[index + offset] = digit;
    });
    onChange(next);
    refs.current[Math.min(index + digits.length, length - 1)]?.focus();
  };

  const onKeyPress = (
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
    index: number,
  ) => {
    if (event.nativeEvent.key === 'Backspace' && !value[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  };

  return (
    <View style={styles.row}>
      {Array.from({ length }, (_, index) => (
        <TextInput
          key={index}
          ref={(node) => { refs.current[index] = node; }}
          accessibilityLabel={`Verification code digit ${index + 1}`}
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          editable={!disabled}
          keyboardType="number-pad"
          maxLength={index === 0 ? length : 1}
          onChangeText={(text) => applyDigits(text, index)}
          onKeyPress={(event) => onKeyPress(event, index)}
          selectionColor={palette.accent}
          style={[
            styles.box,
            {
              backgroundColor: palette.surfaceRaised,
              borderColor: value[index] ? palette.accent : palette.border,
              color: palette.text,
            },
          ]}
          textContentType={index === 0 ? 'oneTimeCode' : 'none'}
          value={value[index] || ''}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 7, justifyContent: 'center' },
  box: {
    borderRadius: 11,
    borderWidth: 1,
    fontSize: 22,
    fontWeight: '700',
    height: 52,
    maxWidth: 52,
    minWidth: 40,
    textAlign: 'center',
  },
});
