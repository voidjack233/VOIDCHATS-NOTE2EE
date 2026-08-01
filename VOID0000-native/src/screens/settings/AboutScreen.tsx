import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import { ChevronRight, Code2, FileText, Lock, MessageCircle } from 'lucide-react-native';
import React, { type ComponentType } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Screen } from '../../components/common/Screen';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'AboutSettings'>;

const APP_VERSION = Constants.expoConfig?.version || '1.0.0';
const APP_BUILD = Platform.select({
  ios: Constants.expoConfig?.ios?.buildNumber,
  android: String(Constants.expoConfig?.android?.versionCode || 1),
  default: 'development',
}) || '1';

export function AboutScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const environment = __DEV__ ? 'Development' : 'Production';

  const legalRow = (
    Icon: ComponentType<{ color?: string; size?: number }>,
    title: string,
    description: string,
    document: 'terms' | 'privacy',
  ) => (
    <Pressable
      accessibilityHint={`Open ${title}`}
      accessibilityRole="button"
      onPress={() => navigation.navigate('Legal', { document })}
      style={({ pressed }) => [styles.legalRow, { backgroundColor: pressed ? palette.hover : 'transparent' }]}
    >
      <View style={[styles.smallIcon, { backgroundColor: `${palette.accent}1f` }]}>
        <Icon color={palette.accent} size={18} />
      </View>
      <View style={styles.legalCopy}>
        <Text style={[styles.legalTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.legalDescription, { color: palette.muted }]}>{description}</Text>
      </View>
      <ChevronRight color={palette.faint} size={19} />
    </Pressable>
  );

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} title="About" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.brand}>
          <View style={[styles.logo, { backgroundColor: palette.accent }]}>
            <MessageCircle color="#ffffff" fill="#ffffff" size={30} />
          </View>
          <Text style={[styles.brandName, { color: palette.text }]}>VOID0000</Text>
          <Text style={[styles.tagline, { color: palette.muted }]}>Private conversations, thoughtfully designed for native.</Text>
        </View>

        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.muted }]}>APP INFORMATION</Text>
          <InfoRow label="Version" value={APP_VERSION} />
          <InfoRow label="Build" value={APP_BUILD} />
          <InfoRow label="Environment" value={environment} />
        </View>

        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[styles.sectionTitle, { color: palette.muted }]}>LEGAL</Text>
          {legalRow(FileText, 'Terms of Use', 'Rules for using VOID0000', 'terms')}
          <View style={[styles.divider, { backgroundColor: palette.border }]} />
          {legalRow(Lock, 'Privacy Policy', 'How account and message data is handled', 'privacy')}
        </View>

        <View style={[styles.card, styles.credits, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Code2 color={palette.accent} size={22} />
          <View style={styles.creditCopy}>
            <Text style={[styles.cardTitle, { color: palette.text }]}>Built with Expo + React Native</Text>
            <Text style={[styles.body, { color: palette.muted }]}>TypeScript, React Navigation, and Lucide icons power this native client.</Text>
          </View>
        </View>

        <Text style={[styles.copyright, { color: palette.faint }]}>© 2026 VOID0000. All rights reserved.</Text>
      </ScrollView>
    </Screen>
  );

  function InfoRow({ label, value }: { label: string; value: string }) {
    return (
      <View style={styles.infoRow}>
        <Text style={[styles.infoLabel, { color: palette.muted }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: palette.text }]}>{value}</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 34 },
  brand: { alignItems: 'center', paddingHorizontal: 22, paddingVertical: 18 },
  logo: { alignItems: 'center', borderRadius: 20, height: 64, justifyContent: 'center', width: 64 },
  brandName: { fontSize: 24, fontWeight: '900', letterSpacing: 0.6, marginTop: 13 },
  tagline: { fontSize: 13, lineHeight: 19, marginTop: 5, textAlign: 'center' },
  card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden', padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.05, marginBottom: 8 },
  infoRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 38 },
  infoLabel: { fontSize: 13 },
  infoValue: { fontSize: 13, fontWeight: '700' },
  legalRow: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', marginHorizontal: -7, padding: 9 },
  smallIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  legalCopy: { flex: 1, marginHorizontal: 11 },
  legalTitle: { fontSize: 14, fontWeight: '700' },
  legalDescription: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 42 },
  credits: { alignItems: 'flex-start', flexDirection: 'row' },
  creditCopy: { flex: 1, marginLeft: 12 },
  cardTitle: { fontSize: 14, fontWeight: '800' },
  body: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  copyright: { fontSize: 11, marginTop: 4, textAlign: 'center' },
});
