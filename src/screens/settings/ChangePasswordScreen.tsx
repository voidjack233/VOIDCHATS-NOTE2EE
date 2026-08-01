import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ShieldCheck } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { TextField } from '../../components/common/TextField';
import { SecurityCard } from '../../components/settings/security/SecurityPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { clearCsrfToken, ensureCsrfToken, toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { useTheme } from '../../theme/ThemeContext';
import { validateAccountPassword } from '../../utils/passwordPolicy';

type Props = NativeStackScreenProps<RootStackParamList, 'ChangePassword'>;
type Method = 'totp' | 'email' | 'backup';

interface FlexibleTwoFactorStatus {
  totp?: unknown;
  email?: unknown;
  backupCodesRemaining?: unknown;
}

const isEnabled = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  return Boolean(value && typeof value === 'object' && (value as { enabled?: unknown }).enabled);
};

const methodLabel: Record<Method, string> = {
  totp: 'Authenticator',
  email: 'Email',
  backup: 'Backup code',
};

export function ChangePasswordScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const [step, setStep] = useState<'confirm' | 'form'>('confirm');
  const [securityChecking, setSecurityChecking] = useState(true);
  const [securityCheckError, setSecurityCheckError] = useState('');
  const [methods, setMethods] = useState<Method[]>([]);
  const [activeMethod, setActiveMethod] = useState<Method>('totp');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const loadSecurityRequirements = useCallback(async () => {
    setSecurityChecking(true);
    setSecurityCheckError('');
    try {
      const result = await authService.get2FAStatus();
      const status = result.twoFactor as unknown as FlexibleTwoFactorStatus;
      const enabled: Method[] = [];
      if (isEnabled(status.totp)) enabled.push('totp');
      if (isEnabled(status.email)) enabled.push('email');
      if (Number(status.backupCodesRemaining) > 0) enabled.push('backup');
      setMethods(enabled);
      setActiveMethod(enabled[0] || 'totp');
    } catch {
      // Changing a password is security-sensitive. Do not assume 2FA is disabled
      // when its status cannot be verified.
      setMethods([]);
      setSecurityCheckError(
        "We couldn't confirm your two-factor settings. Try again before changing your password.",
      );
    } finally {
      setSecurityChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadSecurityRequirements();
  }, [loadSecurityRequirements]);

  useEffect(() => {
    if (emailCooldown === null) return;
    const timer = setInterval(() => {
      setEmailCooldown((current) => current !== null && current > 1 ? current - 1 : null);
    }, 1_000);
    return () => clearInterval(timer);
  }, [emailCooldown !== null]);

  useEffect(() => {
    setTwoFactorCode('');
    setEmailSent(false);
    setEmailCooldown(null);
    setError('');
  }, [activeMethod]);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => navigation.goBack(), 2_000);
    return () => clearTimeout(timer);
  }, [navigation, success]);

  const requires2FA = methods.length > 0;
  const normalizedCode = activeMethod === 'backup'
    ? twoFactorCode.trim().toUpperCase()
    : twoFactorCode.trim();
  const codeReady = !requires2FA || (activeMethod === 'backup'
    ? /^[A-F0-9]{8}$/.test(normalizedCode)
    : /^\d{6}$/.test(normalizedCode));

  const sendEmailCode = async () => {
    if (emailSending || emailCooldown !== null) return;
    setEmailSending(true);
    setError('');
    try {
      const result = await authService.sendActionEmailCode();
      const retryAfterSeconds = Number(
        (result as typeof result & { retryAfterSeconds?: unknown }).retryAfterSeconds,
      );
      setEmailSent(true);
      setEmailCooldown(retryAfterSeconds > 0 ? retryAfterSeconds : 60);
    } catch (caught) {
      setError(toApiError(caught, 'Failed to send email code').message);
    } finally {
      setEmailSending(false);
    }
  };

  const submit = async () => {
    setError('');
    if (securityChecking || securityCheckError) {
      setError("We couldn't confirm your two-factor settings. Please retry the security check.");
      return;
    }
    if (!currentPassword) {
      setError('Please enter your current password');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    const passwordError = validateAccountPassword(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (requires2FA && !normalizedCode) {
      setError('Please enter your 2FA code');
      return;
    }
    if (!codeReady) {
      setError(activeMethod === 'backup'
        ? 'Backup code must be 8 characters.'
        : '2FA code must be 6 digits.');
      return;
    }

    setLoading(true);
    try {
      await authService.changePassword(
        currentPassword,
        newPassword,
        requires2FA ? { method: activeMethod, code: normalizedCode } : null,
      );
      clearCsrfToken();
      // The password change has already succeeded if CSRF reacquisition is
      // temporarily unavailable, so do not present that as a password error.
      await ensureCsrfToken().catch(() => null);
      setSuccess(true);
    } catch (caught) {
      setError(toApiError(caught, 'Failed to change password').message);
    } finally {
      setLoading(false);
    }
  };

  const codeHint = useMemo(() => {
    if (!twoFactorCode || codeReady) return '';
    return activeMethod === 'backup'
      ? 'Enter the full 8-character backup code before continuing.'
      : 'Enter the full 6-digit code before continuing.';
  }, [activeMethod, codeReady, twoFactorCode]);

  if (success) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Change Password" />
        <View style={styles.successContainer}>
          <StateView
            message="Returning to your account settings..."
            title="Password changed successfully!"
            type="empty"
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen keyboard>
      <AppHeader onBack={() => navigation.goBack()} title="Change Password" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {step === 'confirm' ? (
          <>
            <FeedbackBanner
              kind="warning"
              message={`You are about to change your password.\n\nThis updates the password used to sign in to your account.${requires2FA ? ' Your account also requires a 2FA code before the change is accepted.' : ''}`}
            />

            {securityChecking ? (
              <StateView compact message="Checking your two-factor settings" title="Checking security" type="loading" />
            ) : securityCheckError ? (
              <StateView
                actionLabel="Retry"
                compact
                message={securityCheckError}
                onAction={() => void loadSecurityRequirements()}
                title="Security check unavailable"
                type="error"
              />
            ) : null}

            <View style={styles.confirmActions}>
              <Button fullWidth onPress={() => navigation.goBack()} variant="secondary">Cancel</Button>
              <Button
                disabled={securityChecking || Boolean(securityCheckError)}
                fullWidth
                onPress={() => setStep('form')}
              >
                {securityChecking ? 'Checking…' : 'Continue'}
              </Button>
            </View>
          </>
        ) : (
          <>
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="Current Password"
              onChangeText={(value) => { setCurrentPassword(value); setError(''); }}
              returnKeyType="next"
              secureTextEntry
              textContentType="password"
              value={currentPassword}
            />
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="New Password"
              onChangeText={(value) => { setNewPassword(value); setError(''); }}
              returnKeyType="next"
              secureTextEntry
              textContentType="newPassword"
              value={newPassword}
            />
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="Confirm New Password"
              onChangeText={(value) => { setConfirmPassword(value); setError(''); }}
              returnKeyType={requires2FA ? 'next' : 'done'}
              secureTextEntry
              textContentType="newPassword"
              value={confirmPassword}
            />

            {requires2FA ? (
              <SecurityCard style={styles.twoFactorCard}>
                <View style={styles.twoFactorHeading}>
                  <ShieldCheck color={palette.accent} size={20} />
                  <View style={styles.twoFactorHeadingCopy}>
                    <Text style={[styles.twoFactorTitle, { color: palette.text }]}>Two-Factor Verification</Text>
                    <Text style={[styles.twoFactorDescription, { color: palette.muted }]}>Enter a valid code before changing your password.</Text>
                  </View>
                </View>

                <View style={styles.methods}>
                  {methods.map((method) => (
                    <Pressable
                      accessibilityRole="button"
                      key={method}
                      onPress={() => setActiveMethod(method)}
                      style={[
                        styles.method,
                        {
                          backgroundColor: activeMethod === method ? palette.accent : palette.hover,
                          borderColor: activeMethod === method ? palette.accent : palette.border,
                        },
                      ]}
                    >
                      <Text style={[
                        styles.methodText,
                        { color: activeMethod === method ? '#ffffff' : palette.muted },
                      ]}>
                        {methodLabel[method]}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {activeMethod === 'email' && !emailSent ? (
                  <Button
                    fullWidth
                    loading={emailSending}
                    onPress={() => void sendEmailCode()}
                    variant="secondary"
                  >
                    {emailSending ? 'Sending code...' : 'Send email code'}
                  </Button>
                ) : null}

                <TextField
                  autoCapitalize={activeMethod === 'backup' ? 'characters' : 'none'}
                  autoCorrect={false}
                  keyboardType={activeMethod === 'backup' ? 'default' : 'number-pad'}
                  maxLength={activeMethod === 'backup' ? 8 : 6}
                  onChangeText={(value) => {
                    setTwoFactorCode(activeMethod === 'backup'
                      ? value.replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 8)
                      : value.replace(/\D/g, '').slice(0, 6));
                    setError('');
                  }}
                  onSubmitEditing={() => void submit()}
                  placeholder={activeMethod === 'backup'
                    ? 'Enter 8-character backup code'
                    : 'Enter 6-digit code'}
                  returnKeyType="done"
                  value={twoFactorCode}
                />
                {codeHint ? <Text style={[styles.codeHint, { color: palette.warning }]}>{codeHint}</Text> : null}

                {activeMethod === 'email' && emailSent ? (
                  <Pressable
                    disabled={emailSending || emailCooldown !== null}
                    onPress={() => void sendEmailCode()}
                  >
                    <Text style={[
                      styles.resend,
                      { color: palette.accent, opacity: emailCooldown !== null ? 0.55 : 1 },
                    ]}>
                      {emailCooldown !== null
                        ? `Resend in ${emailCooldown}s`
                        : emailSending
                          ? 'Sending...'
                          : 'Resend code'}
                    </Text>
                  </Pressable>
                ) : null}
              </SecurityCard>
            ) : null}

            {error ? <FeedbackBanner message={error} onDismiss={() => setError('')} /> : null}
            <Button
              disabled={securityChecking || Boolean(securityCheckError) || !codeReady}
              fullWidth
              loading={loading}
              onPress={() => void submit()}
            >
              {loading ? 'Changing...' : 'Change Password'}
            </Button>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: 16, padding: 18, paddingBottom: 36 },
  confirmActions: { gap: 10, marginTop: 'auto', paddingTop: 20 },
  successContainer: { flex: 1 },
  twoFactorCard: { gap: 14 },
  twoFactorHeading: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  twoFactorHeadingCopy: { flex: 1 },
  twoFactorTitle: { fontSize: 14, fontWeight: '800' },
  twoFactorDescription: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  method: { borderRadius: 9, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  methodText: { fontSize: 12, fontWeight: '700' },
  codeHint: { fontSize: 12, lineHeight: 17, marginTop: -7 },
  resend: { fontSize: 12, fontWeight: '700', paddingVertical: 2 },
});
