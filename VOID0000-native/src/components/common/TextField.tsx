import { Eye, EyeOff } from 'lucide-react-native';
import React, { forwardRef, useState } from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme/ThemeContext';

interface TextFieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  containerStyle?: StyleProp<ViewStyle>;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, secureTextEntry, containerStyle, multiline, style, ...props },
  ref,
) {
  const { palette } = useTheme();
  const [hidden, setHidden] = useState(Boolean(secureTextEntry));

  return (
    <View style={containerStyle}>
      {label ? <Text style={[styles.label, { color: palette.text }]}>{label}</Text> : null}
      <View style={[
        styles.wrapper,
        multiline && styles.multilineWrapper,
        { backgroundColor: palette.surfaceRaised, borderColor: error ? palette.danger : palette.border },
      ]}>
        <TextInput
          ref={ref}
          placeholderTextColor={palette.faint}
          selectionColor={palette.accent}
          secureTextEntry={secureTextEntry ? hidden : false}
          multiline={multiline}
          style={[
            styles.input,
            multiline && styles.multilineInput,
            { color: palette.text },
            style,
          ]}
          {...props}
        />
        {secureTextEntry ? (
          <Pressable
            accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => setHidden((current) => !current)}
            style={styles.eye}
          >
            {hidden
              ? <Eye size={19} color={palette.muted} />
              : <EyeOff size={19} color={palette.muted} />}
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  label: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  wrapper: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 50,
  },
  multilineWrapper: { alignItems: 'flex-start', minHeight: 110 },
  input: { flex: 1, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  multilineInput: { minHeight: 106, textAlignVertical: 'top' },
  eye: { padding: 14, paddingLeft: 4 },
  error: { fontSize: 12, marginTop: 6 },
});
