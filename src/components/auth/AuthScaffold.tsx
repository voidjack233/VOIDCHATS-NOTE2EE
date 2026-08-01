import { LinearGradient } from 'expo-linear-gradient';
import React, { PropsWithChildren, ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface AuthScaffoldProps {
  title?: string;
  subtitle?: string;
  footer?: ReactNode;
}

export function AuthScaffold({ children, title, subtitle, footer }: PropsWithChildren<AuthScaffoldProps>) {
  return (
    <LinearGradient colors={['#111827', '#1f2937', '#111827'] as const} style={styles.gradient}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.card}>
              {title ? <Text style={styles.title}>{title}</Text> : null}
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
              <View style={styles.content}>{children}</View>
            </View>
            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 24 },
  card: { width: '100%' },
  title: { color: '#ffffff', fontSize: 30, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  subtitle: { color: '#9ca3af', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  content: { gap: 18, marginTop: 28 },
  footer: { alignItems: 'center', marginTop: 28 },
});
