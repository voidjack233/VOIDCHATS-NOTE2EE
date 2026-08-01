import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Screen } from '../../components/common/Screen';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Legal'>;

const documents = {
  terms: {
    title: 'Terms of Use',
    sections: [
      ['Acceptance of Terms', 'By accessing or using VOID, you agree to these Terms of Use and all applicable laws and regulations.'],
      ['Your Account', 'You are responsible for your account credentials, activity, and the information you choose to share. Do not use VOID to harm, harass, or impersonate others.'],
      ['Service Use', 'Use the service only for lawful purposes. Attempts to disrupt, reverse engineer, or gain unauthorized access to the service are prohibited.'],
      ['Content', 'You retain responsibility for content you send. You must have the rights needed to upload and share any message or attachment.'],
      ['Availability', 'The service may change, pause, or become unavailable. Security updates may require you to sign in again.'],
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      ['Information We Process', 'VOID processes account details, profile information, device sessions, friendships, conversations, messages, and attachments needed to provide the service.'],
      ['How Information Is Used', 'Information is used to authenticate you, deliver messages, manage safety and security, maintain sessions, and improve reliability.'],
      ['Security', 'The service uses protected session cookies, CSRF controls, optional two-factor authentication, and server-side refresh-session rotation.'],
      ['Your Choices', 'You can update profile and appearance settings, manage active sessions, change your password, enable two-factor authentication, and sign out.'],
      ['Retention', 'Information is retained only as needed to operate the service, meet legal obligations, and protect users and the platform.'],
    ],
  },
} as const;

export function LegalScreen({ navigation, route }: Props) {
  const { palette } = useTheme();
  const document = documents[route.params.document];
  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} title={document.title} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.updated, { color: palette.muted }]}>Last updated January 2026</Text>
        {document.sections.map(([title, body]) => (
          <View key={title} style={styles.section}>
            <Text style={[styles.heading, { color: palette.text }]}>{title}</Text>
            <Text style={[styles.body, { color: palette.muted }]}>{body}</Text>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48 },
  updated: { fontSize: 13, marginBottom: 24 },
  section: { marginBottom: 24 },
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  body: { fontSize: 14, lineHeight: 22 },
});
