import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ChevronRight, KeyRound, Mail, Smartphone } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AuthFooter } from '../../components/auth/AuthFooter';
import { AuthScaffold } from '../../components/auth/AuthScaffold';
import { OtpInput } from '../../components/auth/OtpInput';
import { Button } from '../../components/common/Button';
import { TextField } from '../../components/common/TextField';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { authStyles } from './authStyles';

type Props = NativeStackScreenProps<RootStackParamList, 'TwoFactor'>;
type Method = 'totp' | 'email' | 'backup';

const methodCopy: Record<Method, { title: string; detail: string }> = {
  totp: { title: 'Authenticator App', detail: 'Get a code from your authenticator app' },
  email: { title: 'Email Verification', detail: 'Get a verification code sent to your email' },
  backup: { title: 'Backup Code', detail: 'Enter one of your 8-character backup codes' },
};

export function TwoFactorScreen({ navigation, route }: Props) {
  const { completeTwoFactor } = useAuth();
  const { challenge } = route.params;
  const [method, setMethod] = useState<Method>(challenge.defaultMethod);
  const [code, setCode] = useState(Array<string>(6).fill(''));
  const [backupCode, setBackupCode] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (cooldown === null) return;
    const timer = setInterval(() => setCooldown((current) => current && current > 1 ? current - 1 : null), 1_000);
    return () => clearInterval(timer);
  }, [cooldown !== null]);

  const switchMethod = (next: Method) => {
    setMethod(next);
    setCode(Array<string>(6).fill(''));
    setBackupCode('');
    setEmailSent(false);
    setSelecting(false);
    setError('');
  };

  const sendEmail = async () => {
    setSendingEmail(true);
    setError('');
    try {
      await authService.sendLoginEmailCode(challenge.twoFactorToken);
      setEmailSent(true);
      setCooldown(60);
    } catch (caught) {
      setError(toApiError(caught, 'Failed to send email code').message);
    } finally {
      setSendingEmail(false);
    }
  };

  const verify = async () => {
    const finalCode = method === 'backup' ? backupCode.trim().toUpperCase() : code.join('');
    if (!finalCode) return;
    setLoading(true);
    setError('');
    try {
      await completeTwoFactor(challenge, finalCode, method);
    } catch (caught) {
      setError(toApiError(caught, 'Invalid 2FA code. Please try again.').message);
    } finally {
      setLoading(false);
    }
  };

  const iconFor = (entry: Method) => entry === 'totp'
    ? Smartphone
    : entry === 'email'
      ? Mail
      : KeyRound;

  if (selecting) {
    return (
      <AuthScaffold
        footer={<AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />}
        subtitle="Select one of the options below to verify your identity."
        title="Choose another way"
      >
        <View style={styles.methods}>
          {challenge.methods.filter((entry) => entry !== method).map((entry) => {
            const Icon = iconFor(entry);
            return (
              <Pressable key={entry} onPress={() => switchMethod(entry)} style={styles.method}>
                <Icon color="#60a5fa" size={22} />
                <View style={styles.methodCopy}>
                  <Text style={styles.methodTitle}>{methodCopy[entry].title}</Text>
                  <Text style={styles.methodDetail}>{methodCopy[entry].detail}</Text>
                </View>
                <ChevronRight color="#6b7280" size={20} />
              </Pressable>
            );
          })}
        </View>
        <Button fullWidth onPress={() => setSelecting(false)} variant="ghost">Cancel</Button>
      </AuthScaffold>
    );
  }

  const subtitle = method === 'totp'
    ? 'Enter the code from your authenticator app'
    : method === 'email'
      ? emailSent ? 'Enter the 6-digit code sent to your email' : 'Click below to send a verification code to your email'
      : 'Enter an 8-character backup code';

  return (
    <AuthScaffold
      footer={<AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />}
      subtitle={subtitle}
      title="Two-Factor Authentication"
    >
      {method === 'email' && !emailSent ? (
        <Button fullWidth loading={sendingEmail} onPress={() => void sendEmail()}>{sendingEmail ? 'Sending...' : 'Send Verification Code'}</Button>
      ) : method === 'backup' ? (
        <TextField
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={8}
          onChangeText={(value) => setBackupCode(value.replace(/[^a-fA-F0-9]/g, '').toUpperCase())}
          onSubmitEditing={() => void verify()}
          placeholder="Enter 8-character backup code"
          style={styles.backup}
          value={backupCode}
        />
      ) : (
        <OtpInput disabled={loading} onChange={setCode} value={code} />
      )}

      {error ? <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View> : null}

      {method !== 'email' || emailSent ? (
        <Button fullWidth loading={loading} onPress={() => void verify()}>Verify</Button>
      ) : null}

      {method === 'email' && emailSent ? (
        <Pressable disabled={cooldown !== null || sendingEmail} onPress={() => void sendEmail()}>
          <Text style={[authStyles.link, styles.center]}>{cooldown !== null ? `Resend in ${cooldown}s` : 'Resend Code'}</Text>
        </Pressable>
      ) : null}

      {challenge.methods.length > 1 ? (
        <Pressable onPress={() => setSelecting(true)}><Text style={[authStyles.link, styles.center]}>Try another way</Text></Pressable>
      ) : null}
      <Pressable onPress={() => navigation.goBack()}><Text style={[authStyles.muted, styles.center]}>Cancel and go back</Text></Pressable>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  methods: { gap: 12 },
  method: { alignItems: 'center', backgroundColor: '#1f2937', borderColor: '#374151', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 14, padding: 16 },
  methodCopy: { flex: 1 },
  methodTitle: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  methodDetail: { color: '#9ca3af', fontSize: 12, marginTop: 3 },
  backup: { fontSize: 20, letterSpacing: 4, textAlign: 'center' },
  center: { textAlign: 'center' },
});
