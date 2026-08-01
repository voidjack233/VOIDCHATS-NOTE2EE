import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Mail } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AuthFooter } from '../../components/auth/AuthFooter';
import { AuthScaffold } from '../../components/auth/AuthScaffold';
import { CaptchaModal } from '../../components/auth/CaptchaModal';
import { Button } from '../../components/common/Button';
import { TextField } from '../../components/common/TextField';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { ApiError, toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { authStyles } from './authStyles';

type Props = NativeStackScreenProps<RootStackParamList, 'SignIn'>;
const COOLDOWN_KEY = 'void_login_cooldown_until';

export function SignInScreen({ navigation }: Props) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [captchaRequired, setCaptchaRequired] = useState<boolean | null>(null);
  const [captchaMode, setCaptchaMode] = useState<'login' | 'resend' | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [cooldown, setCooldown] = useState<number | null>(null);

  useEffect(() => {
    void authService.checkCaptchaRequired('login').then((result) => setCaptchaRequired(result.captchaRequired));
    void AsyncStorage.getItem(COOLDOWN_KEY).then((raw) => {
      const until = Number(raw);
      const remaining = Math.ceil((until - Date.now()) / 1_000);
      if (remaining > 0) {
        setCooldown(remaining);
        setError('Too many attempts. Try again later.');
      } else {
        void AsyncStorage.removeItem(COOLDOWN_KEY);
      }
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

  const formatCooldown = () => {
    if (cooldown === null) return '';
    return cooldown >= 60
      ? `${Math.floor(cooldown / 60)}:${String(cooldown % 60).padStart(2, '0')}`
      : `${cooldown}s`;
  };

  const performLogin = async (captcha?: { captchaId: string; captchaAnswer: string }) => {
    setCaptchaMode(null);
    setLoading(true);
    setError('');
    setUnverifiedEmail(null);
    try {
      const result = await login(identifier, password, captcha);
      setPassword('');
      if (result.challenge) navigation.navigate('TwoFactor', { challenge: result.challenge });
    } catch (caught) {
      const apiError = toApiError(caught, 'Login failed');
      const payload = apiError.payload || {};
      if (apiError.code === 'CAPTCHA_REQUIRED') {
        setCaptchaRequired(true);
        setCaptchaMode('login');
        return;
      }
      if (apiError.code === 'EMAIL_NOT_VERIFIED') {
        const email = typeof payload.email === 'string' ? payload.email : identifier;
        setUnverifiedEmail(email);
        setError(apiError.message || 'Please verify your email before logging in.');
        return;
      }
      if (apiError.code === 'LOGIN_RATE_LIMITED' || apiError.code === 'LOGIN_RATE_LIMIT_EXCEEDED') {
        const retryAfter = Number(payload.retryAfterMs || 60_000);
        const until = Number(payload.cooldownUntil) || Date.now() + retryAfter;
        setCooldown(Math.max(1, Math.ceil((until - Date.now()) / 1_000)));
        await AsyncStorage.setItem(COOLDOWN_KEY, String(until));
        setError('Too many attempts. Try again later.');
        return;
      }
      setError(apiError instanceof ApiError ? apiError.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const submit = () => {
    if (cooldown !== null) {
      setError('Too many attempts. Try again later.');
      return;
    }
    if (!identifier.trim() || !password.trim()) {
      setError('Please enter both email/username and password');
      return;
    }
    if (captchaRequired === false) void performLogin();
    else setCaptchaMode('login');
  };

  const resend = async (captchaId: string, captchaAnswer: string) => {
    if (!unverifiedEmail) return;
    setCaptchaMode(null);
    setResendStatus('sending');
    try {
      const result = await authService.resendVerification(unverifiedEmail, { captchaId, captchaAnswer });
      setResendStatus('sent');
      if (result.verificationToken) {
        navigation.navigate('EmailVerification', { token: result.verificationToken });
      }
    } catch {
      setResendStatus('error');
    }
  };

  return (
    <AuthScaffold
      footer={<AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />}
      subtitle="Sign in to your account"
      title="Sign In"
    >
      <View style={authStyles.fields}>
        <TextField
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading}
          label="Email or Username"
          onChangeText={(text) => { setIdentifier(text.replace(/ /g, '')); setError(''); setUnverifiedEmail(null); }}
          onSubmitEditing={() => submit()}
          placeholder="Email or Username"
          returnKeyType="next"
          textContentType="username"
          value={identifier}
        />
        <TextField
          autoCapitalize="none"
          editable={!loading}
          label="Password"
          onChangeText={(text) => { setPassword(text.replace(/ /g, '')); setError(''); }}
          onSubmitEditing={() => submit()}
          placeholder="Enter your password"
          returnKeyType="go"
          secureTextEntry
          textContentType="password"
          value={password}
        />
      </View>

      {error ? (
        <View style={authStyles.errorBox}>
          {unverifiedEmail ? (
            <View style={styles.unverified}>
              <Mail color="#f87171" size={19} />
              <View style={styles.unverifiedCopy}>
                <Text style={authStyles.error}>
                  Please verify your email {unverifiedEmail} before logging in.
                </Text>
                <Pressable disabled={resendStatus === 'sending' || resendStatus === 'sent'} onPress={() => setCaptchaMode('resend')}>
                  <Text style={[authStyles.link, styles.resend]}>
                    {resendStatus === 'sending' ? 'Sending...' : resendStatus === 'sent' ? 'Email Sent!' : resendStatus === 'error' ? 'Try Again' : 'Resend Verification'}
                  </Text>
                </Pressable>
                {resendStatus === 'sent' ? <Text style={authStyles.success}>Verification email sent! Check your inbox.</Text> : null}
                {resendStatus === 'error' ? <Text style={authStyles.error}>Failed to send. Please try again.</Text> : null}
              </View>
            </View>
          ) : <Text style={authStyles.error}>{error}</Text>}
        </View>
      ) : null}

      <Pressable disabled={loading} onPress={() => navigation.navigate('ForgotPassword')}>
        <Text style={authStyles.link}>Forgot password?</Text>
      </Pressable>

      <Button disabled={cooldown !== null} fullWidth loading={loading} onPress={submit} variant="secondary">
        {cooldown !== null ? `Retry in ${formatCooldown()}` : loading ? 'Signing In...' : 'Sign In'}
      </Button>

      <View style={authStyles.inline}>
        <Text style={authStyles.muted}>Don't have an account? </Text>
        <Pressable disabled={loading} onPress={() => navigation.navigate('Register')}>
          <Text style={authStyles.link}>Sign up</Text>
        </Pressable>
      </View>

      <CaptchaModal
        onClose={() => setCaptchaMode(null)}
        onVerified={(captchaId, captchaAnswer) => captchaMode === 'resend'
          ? resend(captchaId, captchaAnswer)
          : performLogin({ captchaId, captchaAnswer })}
        visible={captchaMode !== null}
      />
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  unverified: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  unverifiedCopy: { flex: 1, gap: 8 },
  resend: { textAlign: 'center' },
});
