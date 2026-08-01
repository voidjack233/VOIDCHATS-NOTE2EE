import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Lock,
  Mail,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { OtpInput } from '../../components/auth/OtpInput';
import { AppHeader } from '../../components/common/AppHeader';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { TextField } from '../../components/common/TextField';
import {
  SecurityCard,
  SecurityRow,
  SecuritySection,
} from '../../components/settings/security/SecurityPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'TwoFactorSettings'>;
type SetupMethod = 'totp' | 'email';
type ViewName = 'status' | 'password' | 'setup-totp' | 'setup-email' | 'disable' | 'backup-codes';
type PendingAction = { type: 'setup'; method: SetupMethod } | { type: 'regenerate' };

interface TwoFactorStatus {
  totp: boolean;
  email: boolean;
  backupCodesRemaining: number;
}

interface FlexibleTwoFactorStatus {
  totp?: unknown;
  email?: unknown;
  backupCodesRemaining?: unknown;
}

const isEnabled = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  return Boolean(value && typeof value === 'object' && (value as { enabled?: unknown }).enabled);
};

const normalizeStatus = (value: unknown): TwoFactorStatus => {
  const status = (value || {}) as FlexibleTwoFactorStatus;
  return {
    totp: isEnabled(status.totp),
    email: isEnabled(status.email),
    backupCodesRemaining: Math.max(0, Number(status.backupCodesRemaining) || 0),
  };
};

const viewTitles: Record<ViewName, string> = {
  status: 'Two-Factor Authentication',
  password: 'Confirm Password',
  'setup-totp': 'Setup Authenticator App',
  'setup-email': 'Setup Email 2FA',
  disable: 'Disable 2FA',
  'backup-codes': 'Backup Codes',
};

export function TwoFactorSettingsScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const [view, setView] = useState<ViewName>('status');
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [disableMethod, setDisableMethod] = useState<SetupMethod | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(Array<string>(6).fill(''));
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError('');
    try {
      const result = await authService.get2FAStatus();
      setStatus(normalizeStatus(result.twoFactor));
    } catch (caught) {
      setStatus(null);
      setError(toApiError(caught, 'Failed to fetch 2FA status.').message);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const resetToStatus = () => {
    setView('status');
    setPendingAction(null);
    setDisableMethod(null);
    setPassword('');
    setCode(Array<string>(6).fill(''));
    setQrCode('');
    setSecret('');
    setBackupCodes([]);
    setCopied(false);
    setError('');
  };

  const goBack = () => {
    if (view === 'status') navigation.goBack();
    else resetToStatus();
  };

  const promptSetup = (method: SetupMethod) => {
    setPendingAction({ type: 'setup', method });
    setPassword('');
    setError('');
    setSuccess('');
    setView('password');
  };

  const promptRegenerate = () => {
    setPendingAction({ type: 'regenerate' });
    setPassword('');
    setError('');
    setSuccess('');
    setView('password');
  };

  const promptDisable = (method: SetupMethod) => {
    setDisableMethod(method);
    setPassword('');
    setError('');
    setSuccess('');
    setView('disable');
  };

  const continueWithPassword = async () => {
    if (!password || !pendingAction) return;
    setSubmitting(true);
    setError('');
    try {
      if (pendingAction.type === 'regenerate') {
        const result = await authService.regenerateBackupCodes(password);
        if (!result.backupCodes?.length) {
          throw new Error('No backup codes were returned. Please try again.');
        }
        setBackupCodes(result.backupCodes);
        setPassword('');
        setView('backup-codes');
        return;
      }

      if (pendingAction.method === 'totp') {
        const result = await authService.setupTOTP(password);
        setQrCode(result.qrCode || '');
        setSecret(result.secret || '');
        setView('setup-totp');
      } else {
        await authService.setupEmail2FA(password);
        setView('setup-email');
      }
      setPassword('');
      setCode(Array<string>(6).fill(''));
    } catch (caught) {
      setError(toApiError(caught, 'Setup failed.').message);
    } finally {
      setSubmitting(false);
    }
  };

  const verifySetup = async () => {
    const method = pendingAction?.type === 'setup' ? pendingAction.method : null;
    const verificationCode = code.join('');
    if (!method || verificationCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await authService.verifySetup2FA(method, verificationCode);
      setSuccess('Two-factor authentication successfully enabled!');
      if (result.backupCodes?.length) {
        setBackupCodes(result.backupCodes);
        setView('backup-codes');
      } else {
        await loadStatus();
        resetToStatus();
      }
    } catch (caught) {
      setError(toApiError(caught, 'Invalid verification code.').message);
    } finally {
      setSubmitting(false);
    }
  };

  const disable = async () => {
    if (!password || !disableMethod) return;
    setSubmitting(true);
    setError('');
    try {
      await authService.disable2FA(disableMethod, password);
      setSuccess(`${disableMethod === 'totp' ? 'Authenticator App' : 'Email 2FA'} has been disabled.`);
      await loadStatus();
      resetToStatus();
    } catch (caught) {
      setError(toApiError(caught, 'Failed to disable 2FA.').message);
    } finally {
      setSubmitting(false);
    }
  };

  const copyBackupCodes = async () => {
    if (!backupCodes.length) return;
    try {
      await Clipboard.setStringAsync(backupCodes.join('\n'));
      setCopied(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to copy backup codes.');
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await Clipboard.setStringAsync(secret);
      setSuccess('Authenticator secret copied.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to copy authenticator secret.');
    }
  };

  const finishBackupCodes = async () => {
    await loadStatus();
    resetToStatus();
  };

  if (view === 'status' && loadingStatus && !status) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title={viewTitles.status} />
        <StateView message="Checking your authentication methods" title="Loading settings..." type="loading" />
      </Screen>
    );
  }

  if (view === 'status' && !status) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title={viewTitles.status} />
        <StateView
          actionLabel="Retry"
          message={error || 'Failed to fetch 2FA status.'}
          onAction={() => void loadStatus()}
          title="Unable to load security settings"
          type="error"
        />
      </Screen>
    );
  }

  const hasAny2FA = Boolean(status?.totp || status?.email);
  const setupMethod = pendingAction?.type === 'setup' ? pendingAction.method : null;

  return (
    <Screen keyboard>
      <AppHeader onBack={goBack} title={viewTitles[view]} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error ? <FeedbackBanner message={error} onDismiss={() => setError('')} /> : null}
        {success ? (
          <FeedbackBanner kind="success" message={success} onDismiss={() => setSuccess('')} />
        ) : null}

        {view === 'status' && status ? (
          <>
            <SecurityCard style={styles.statusCard}>
              <View style={[
                styles.statusIcon,
                { backgroundColor: `${hasAny2FA ? palette.success : palette.warning}18` },
              ]}>
                {hasAny2FA
                  ? <ShieldCheck color={palette.success} size={27} />
                  : <ShieldAlert color={palette.warning} size={27} />}
              </View>
              <View style={styles.statusCopy}>
                <Text style={[styles.statusTitle, { color: palette.text }]}>2FA is {hasAny2FA ? 'Enabled' : 'Disabled'}</Text>
                <Text style={[styles.statusDescription, { color: palette.muted }]}>
                  {hasAny2FA
                    ? 'Your account is protected with an extra layer of security.'
                    : 'Add an extra layer of security to your account.'}
                </Text>
              </View>
            </SecurityCard>

            <SecuritySection title="Authentication Methods">
              <SecurityRow
                description="Use apps like Google Auth or Authy"
                icon={<Smartphone color={palette.accent} size={20} />}
                onPress={() => status.totp ? promptDisable('totp') : promptSetup('totp')}
                title="Authenticator App"
                trailing={
                  <Switch
                    accessibilityLabel={`${status.totp ? 'Disable' : 'Enable'} Authenticator App`}
                    onValueChange={() => status.totp ? promptDisable('totp') : promptSetup('totp')}
                    trackColor={{ false: palette.hover, true: palette.accent }}
                    thumbColor="#ffffff"
                    value={status.totp}
                  />
                }
              />
              <SecurityRow
                description="Receive verification codes via email"
                icon={<Mail color={palette.accent} size={20} />}
                onPress={() => status.email ? promptDisable('email') : promptSetup('email')}
                title="Email Authentication"
                trailing={
                  <Switch
                    accessibilityLabel={`${status.email ? 'Disable' : 'Enable'} Email Authentication`}
                    onValueChange={() => status.email ? promptDisable('email') : promptSetup('email')}
                    trackColor={{ false: palette.hover, true: palette.accent }}
                    thumbColor="#ffffff"
                    value={status.email}
                  />
                }
              />
            </SecuritySection>

            {hasAny2FA ? (
              <SecuritySection title="Recovery">
                <SecurityRow
                  description={`${status.backupCodesRemaining} codes remaining`}
                  icon={<KeyRound color={palette.warning} size={20} />}
                  onPress={promptRegenerate}
                  title="Backup Codes"
                />
              </SecuritySection>
            ) : null}
          </>
        ) : null}

        {view === 'password' ? (
          <View style={styles.flow}>
            <View style={[styles.heroIcon, { backgroundColor: `${palette.accent}18` }]}>
              <Lock color={palette.accent} size={31} />
            </View>
            <Text style={[styles.flowDescription, { color: palette.text }]}>
              {pendingAction?.type === 'regenerate'
                ? 'Enter your password to generate a new set of backup codes.'
                : `Enter your password to set up ${setupMethod === 'totp' ? 'Authenticator App' : 'Email Authentication'}.`}
            </Text>
            {pendingAction?.type === 'regenerate' ? (
              <FeedbackBanner
                kind="warning"
                message="Generating new backup codes invalidates your existing backup codes."
              />
            ) : null}
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              label="Password"
              onChangeText={(value) => { setPassword(value); setError(''); }}
              onSubmitEditing={() => void continueWithPassword()}
              placeholder="Enter your password"
              returnKeyType="done"
              secureTextEntry
              textContentType="password"
              value={password}
            />
            <Button
              disabled={!password}
              fullWidth
              loading={submitting}
              onPress={() => void continueWithPassword()}
            >
              {submitting ? 'Verifying...' : 'Continue'}
            </Button>
          </View>
        ) : null}

        {view === 'setup-totp' ? (
          <View style={styles.flow}>
            <Text style={[styles.instruction, { color: palette.text }]}>1. Scan this QR code with your authenticator app.</Text>
            {qrCode ? (
              <View style={styles.qrWrapper}>
                <Image accessibilityLabel="2FA QR Code" resizeMode="contain" source={{ uri: qrCode }} style={styles.qr} />
              </View>
            ) : (
              <FeedbackBanner kind="warning" message="A QR code was not returned. Use the manual setup code below." />
            )}
            <Text style={[styles.manualLabel, { color: palette.muted }]}>Or enter this code manually:</Text>
            <Pressable
              accessibilityHint="Copies the authenticator setup code"
              accessibilityRole="button"
              onPress={() => void copySecret()}
              style={[styles.secret, { backgroundColor: palette.bg, borderColor: palette.border }]}
            >
              <Text selectable style={[styles.secretText, { color: palette.accent }]}>{secret || 'Not available'}</Text>
              {secret ? <Copy color={palette.muted} size={17} /> : null}
            </Pressable>
            <View style={[styles.flowDivider, { backgroundColor: palette.border }]} />
            <Text style={[styles.instruction, { color: palette.text }]}>2. Enter the 6-digit code from your app</Text>
            <OtpInput disabled={submitting} onChange={(value) => { setCode(value); setError(''); }} value={code} />
            <Button
              disabled={code.join('').length !== 6}
              fullWidth
              loading={submitting}
              onPress={() => void verifySetup()}
            >
              {submitting ? 'Verifying...' : 'Verify and Enable'}
            </Button>
          </View>
        ) : null}

        {view === 'setup-email' ? (
          <View style={styles.flow}>
            <View style={[styles.heroIcon, { backgroundColor: `${palette.accent}18` }]}>
              <Mail color={palette.accent} size={31} />
            </View>
            <Text style={[styles.flowDescription, { color: palette.text }]}>We've sent a 6-digit verification code to your email.</Text>
            <Text style={[styles.instruction, { color: palette.text }]}>Enter the code</Text>
            <OtpInput disabled={submitting} onChange={(value) => { setCode(value); setError(''); }} value={code} />
            <Button
              disabled={code.join('').length !== 6}
              fullWidth
              loading={submitting}
              onPress={() => void verifySetup()}
            >
              {submitting ? 'Verifying...' : 'Verify and Enable'}
            </Button>
          </View>
        ) : null}

        {view === 'disable' ? (
          <View style={styles.flow}>
            <FeedbackBanner
              kind="warning"
              message={`Disabling ${disableMethod === 'totp' ? 'Authenticator App' : 'Email Authentication'} will make your account less secure.`}
            />
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              label="Current Password"
              onChangeText={(value) => { setPassword(value); setError(''); }}
              onSubmitEditing={() => void disable()}
              placeholder="Enter your password"
              returnKeyType="done"
              secureTextEntry
              textContentType="password"
              value={password}
            />
            <Button
              disabled={!password}
              fullWidth
              loading={submitting}
              onPress={() => void disable()}
              variant="danger"
            >
              {submitting ? 'Disabling...' : 'Confirm Disable'}
            </Button>
          </View>
        ) : null}

        {view === 'backup-codes' ? (
          <View style={styles.flow}>
            <FeedbackBanner
              kind="warning"
              message={'Save these backup codes!\n\nEach code can only be used once. Keep them safe.'}
            />
            {backupCodes.length ? (
              <View style={[styles.codes, { backgroundColor: palette.bg, borderColor: palette.border }]}>
                {backupCodes.map((backupCode) => (
                  <Text key={backupCode} selectable style={[styles.backupCode, { color: palette.accent }]}>{backupCode}</Text>
                ))}
              </View>
            ) : (
              <StateView compact message="No backup codes were returned." title="Backup codes unavailable" type="empty" />
            )}
            <Button
              disabled={!backupCodes.length}
              fullWidth
              onPress={() => void copyBackupCodes()}
              variant="secondary"
            >
              {copied
                ? <><CheckCircle2 color={palette.success} size={18} /><Text style={[styles.buttonLabel, { color: palette.text }]}>Copied to Clipboard</Text></>
                : <><Copy color={palette.text} size={18} /><Text style={[styles.buttonLabel, { color: palette.text }]}>Copy Codes</Text></>}
            </Button>
            <Button disabled={!backupCodes.length} fullWidth onPress={() => void finishBackupCodes()}>
              I have saved them
            </Button>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: 22, padding: 18, paddingBottom: 36 },
  statusCard: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  statusIcon: { alignItems: 'center', borderRadius: 999, height: 50, justifyContent: 'center', width: 50 },
  statusCopy: { flex: 1 },
  statusTitle: { fontSize: 15, fontWeight: '800' },
  statusDescription: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  flow: { gap: 18 },
  heroIcon: { alignItems: 'center', alignSelf: 'center', borderRadius: 999, height: 64, justifyContent: 'center', width: 64 },
  flowDescription: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  instruction: { fontSize: 14, fontWeight: '700', lineHeight: 20, textAlign: 'center' },
  qrWrapper: { alignSelf: 'center', backgroundColor: '#ffffff', borderRadius: 14, padding: 12 },
  qr: { height: 184, width: 184 },
  manualLabel: { fontSize: 12, marginBottom: -10, textAlign: 'center' },
  secret: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', padding: 12 },
  secretText: { flexShrink: 1, fontFamily: 'monospace', fontSize: 13, fontWeight: '700', letterSpacing: 0.8, textAlign: 'center' },
  flowDivider: { height: StyleSheet.hairlineWidth },
  codes: { borderRadius: 14, borderWidth: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16 },
  backupCode: { flexBasis: '46%', fontFamily: 'monospace', fontSize: 14, fontWeight: '700', letterSpacing: 1.2, textAlign: 'center' },
  buttonLabel: { fontSize: 15, fontWeight: '700' },
});
