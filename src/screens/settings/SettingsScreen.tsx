import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Bell,
  ChevronRight,
  Info,
  Palette,
  Shield,
  User,
} from 'lucide-react-native';
import React, { type ComponentType } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Screen } from '../../components/common/Screen';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

interface SettingsRowProps {
  description: string;
  icon: ComponentType<{ color?: string; size?: number }>;
  onPress: () => void;
  title: string;
}

export function SettingsScreen({ navigation }: Props) {
  const { palette } = useTheme();

  const renderRow = ({ description, icon: Icon, onPress, title }: SettingsRowProps) => (
    <Pressable
      accessibilityHint={description}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? palette.hover : palette.surface,
          borderColor: palette.border,
        },
      ]}
    >
      <View style={[styles.iconFrame, { backgroundColor: `${palette.accent}1f` }]}>
        <Icon color={palette.accent} size={21} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.rowDescription, { color: palette.muted }]}>{description}</Text>
      </View>
      <ChevronRight color={palette.faint} size={20} />
    </Pressable>
  );

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} subtitle="Manage your VOID0000 experience" title="Settings" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.sectionLabel, { color: palette.muted }]}>YOUR ACCOUNT</Text>
        <View style={styles.rows}>
          {renderRow({
            description: 'Display name, bio, and profile photo',
            icon: User,
            onPress: () => navigation.navigate('ProfileSettings'),
            title: 'Profile',
          })}
          {renderRow({
            description: 'Email, password, sessions, and two-factor security',
            icon: Shield,
            onPress: () => navigation.navigate('AccountSettings'),
            title: 'Account & Security',
          })}
        </View>

        <Text style={[styles.sectionLabel, { color: palette.muted }]}>APP SETTINGS</Text>
        <View style={styles.rows}>
          {renderRow({
            description: 'Theme, density, spacing, and chat text size',
            icon: Palette,
            onPress: () => navigation.navigate('AppearanceSettings'),
            title: 'Appearance',
          })}
          {renderRow({
            description: 'In-app sound preference and push availability',
            icon: Bell,
            onPress: () => navigation.navigate('NotificationsSettings'),
            title: 'Notifications',
          })}
          {renderRow({
            description: 'Version details, legal documents, and credits',
            icon: Info,
            onPress: () => navigation.navigate('AboutSettings'),
            title: 'About',
          })}
        </View>

        <Text style={[styles.footer, { color: palette.faint }]}>VOID0000 Native · Version 1.0.0</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 30 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 9,
    marginTop: 10,
    paddingHorizontal: 2,
  },
  rows: { gap: 10, marginBottom: 18 },
  row: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 82,
    padding: 16,
  },
  iconFrame: {
    alignItems: 'center',
    borderRadius: 12,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  rowCopy: { flex: 1, marginHorizontal: 13, minWidth: 0 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowDescription: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  footer: { fontSize: 11, marginTop: 2, textAlign: 'center' },
});
