import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AuthFooter } from '../../components/auth/AuthFooter';
import { AuthScaffold } from '../../components/auth/AuthScaffold';
import { CaptchaModal } from '../../components/auth/CaptchaModal';
import { Button } from '../../components/common/Button';
import { TextField } from '../../components/common/TextField';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { authStyles } from './authStyles';

type Props = NativeStackScreenProps<RootStackParamList, 'ForgotPassword'>;
const COOLDOWN_KEY = 'void_forgot_password_cooldown';

export function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [cooldown, setCooldown] = useState<number | null>(null);

  useEffect(() => {
    void AsyncStorage.getItem(COOLDOWN_KEY).then((raw) => {
      const remaining = Math.floor((Number(raw) - Date.now()) / 1_000);
      if (remaining > 0) setCooldown(remaining);
      else void AsyncStorage.removeItem(COOLDOWN_KEY);
    });
  }, []);

  useEffect(() => {
    if (cooldown === null) return;
    const timer = setInterval(() => setCooldown((current) => {
      if (current === null || current <= 1) {
        void AsyncStorage.removeItem(COOLDOWN_KEY);
        return null;
      }
      return current - 1;
    }), 1_000);
    return () => clearInterval(timer);
  }, [cooldown !== null]);

  const send = async (captchaId: string, captchaAnswer: string) => {
    setShowCaptcha(false);
    setLoading(true);
    setError('');
    try {
      await authService.forgotPassword(email, { captchaId, captchaAnswer });
      setSuccess(true);
    } catch (caught) {
      const apiError = toApiError(caught, 'Password reset failed');
      if (apiError.code === 'FORGOT_RATE_LIMIT_EXCEEDED') {
        const resetTime = Number(apiError.payload?.resetTime) || Date.now() + 60_000;
        const remaining = Math.max(1, Math.floor((resetTime - Date.now()) / 1_000));
        setCooldown(remaining);
        await AsyncStorage.setItem(COOLDOWN_KEY, String(resetTime));
      }
      setError(apiError.message || 'Password reset failed');
    } finally {
      setLoading(false);
    }
  };

  const submit = () => {
    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }
    setError('');
    setShowCaptcha(true);
  };

  return (
    <AuthScaffold
      footer={<AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />}
      subtitle="Enter your email to receive a reset link"
      title="Reset Password"
    >
      {success ? (
        <View style={authStyles.successBox}>
          <Text style={authStyles.success}>Reset link has been sent to your email</Text>
        </View>
      ) : (
        <>
          <TextField
            autoCapitalize="none"
            editable={!loading && cooldown === null}
            keyboardType="email-address"
            label="Email"
            onChangeText={(value) => { setEmail(value); setError(''); }}
            onSubmitEditing={submit}
            placeholder="Enter your email address"
            textContentType="emailAddress"
            value={email}
          />
          {error ? <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View> : null}
          <Button disabled={cooldown !== null} fullWidth loading={loading} onPress={submit} variant="secondary">
            {cooldown !== null ? `Retry in ${cooldown}s` : loading ? 'Sending...' : 'Send Reset Link'}
          </Button>
        </>
      )}

      <View style={authStyles.inline}>
        <Text style={authStyles.muted}>{success ? '' : 'Remember your password? '}</Text>
        <Pressable onPress={() => navigation.navigate('SignIn')}>
          <Text style={authStyles.link}>{success ? 'Back to login' : 'Sign in'}</Text>
        </Pressable>
      </View>

      <CaptchaModal
        onClose={() => setShowCaptcha(false)}
        onVerified={send}
        visible={showCaptcha}
      />
    </AuthScaffold>
  );
}
