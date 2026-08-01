import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  KeyRound,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
  Trash2,
} from 'lucide-react-native';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ReadOnlyField,
  SecurityCard,
  SecurityRow,
  SecuritySection,
} from '../../components/settings/security/SecurityPrimitives';
import { AppHeader } from '../../components/common/AppHeader';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'AccountSettings'>;

export function AccountScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const { user, cachedUser, status, retry, logout, isLoggingOut } = useAuth();
  const [error, setError] = useState('');
  const account = user || cachedUser;

  const handleLogout = async () => {
    setError('');
    try {
      await logout();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to log out. Please try again.');
    }
  };

  if (status === 'checking' && !account) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Account" />
        <StateView title="Loading account" type="loading" />
      </Screen>
    );
  }

  if (!account) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Account" />
        <StateView
          actionLabel="Retry"
          message="Your account information could not be loaded."
          onAction={() => void retry()}
          title="Account information unavailable"
          type={status === 'unavailable' ? 'offline' : 'empty'}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} subtitle="Manage your account" title="Account" />
      <ScrollView contentContainerStyle={styles.content}>
        {status === 'unavailable' ? (
          <FeedbackBanner
            kind="warning"
            message="Account service is unavailable. Your login is preserved and will be retried."
          />
        ) : null}
        {error ? <FeedbackBanner message={error} onDismiss={() => setError('')} /> : null}

        <SecuritySection title="Account Information">
          <SecurityCard style={styles.accountCard}>
            <ReadOnlyField
              hint="Email cannot be changed"
              label="Email Address"
              value={account.email || 'Not available'}
            />
            <View style={[styles.divider, { backgroundColor: palette.border }]} />
            <ReadOnlyField
              hint="Username cannot be changed"
              label="Username"
              value={account.username || 'Not available'}
            />
          </SecurityCard>
        </SecuritySection>

        <SecuritySection title="Security">
          <SecurityRow
            description="Update your account password"
            icon={<KeyRound color={palette.accent} size={20} />}
            onPress={() => navigation.navigate('ChangePassword')}
            title="Change Password"
          />
          <SecurityRow
            description="Manage your 2FA settings"
            icon={<ShieldCheck color={palette.accent} size={20} />}
            onPress={() => navigation.navigate('TwoFactorSettings')}
            title="Two-Factor Authentication"
          />
          <SecurityRow
            description="Manage your signed-in devices"
            icon={<MonitorSmartphone color={palette.accent} size={20} />}
            onPress={() => navigation.navigate('ActiveSessions')}
            title="Active Sessions"
          />
        </SecuritySection>

        <SecuritySection title="Sign Out">
          <SecurityRow
            description="Sign out of your account"
            disabled={isLoggingOut}
            icon={<LogOut color={palette.warning} size={20} />}
            onPress={() => void handleLogout()}
            title={isLoggingOut ? 'Logging out...' : 'Log Out'}
            tone="warning"
          />
        </SecuritySection>

        <SecuritySection title="Danger Zone" tone="danger">
          <SecurityRow
            description="Account deletion is not available in this app."
            disabled
            icon={<Trash2 color={palette.danger} size={20} />}
            title="Delete Account"
            tone="danger"
            trailing={
              <View style={[styles.unavailable, { borderColor: `${palette.danger}66` }]}>
                <Text style={[styles.unavailableText, { color: palette.danger }]}>Unavailable</Text>
              </View>
            }
          />
        </SecuritySection>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 24, padding: 18, paddingBottom: 36 },
  accountCard: { gap: 16 },
  divider: { height: StyleSheet.hairlineWidth },
  unavailable: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  unavailableText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
});
