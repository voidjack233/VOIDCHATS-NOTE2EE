import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AuthFooter } from '../../components/auth/AuthFooter';
import { AuthScaffold } from '../../components/auth/AuthScaffold';
import { CaptchaModal } from '../../components/auth/CaptchaModal';
import { OtpInput } from '../../components/auth/OtpInput';
import { Button } from '../../components/common/Button';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { authStyles } from './authStyles';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailVerification'>;

export function EmailVerificationScreen({ navigation, route }: Props) {
  const token = route.params.token;
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState(Array<string>(6).fill(''));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [cooldown, setCooldown] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    if (!token) {
      setTokenValid(false);
      setError('Invalid access. Please register first.');
      return;
    }
    void authService.validateVerificationToken(token).then((result) => {
      if (!active) return;
      setTokenValid(true);
      setEmail(result.email || null);
      setCodeSent(Boolean(result.codeSent));
    }).catch((caught) => {
      if (!active) return;
      setTokenValid(false);
      setError(toApiError(caught, 'Failed to validate access').message);
    });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (cooldown === null) return;
    const timer = setInterval(() => setCooldown((current) => current && current > 1 ? current - 1 : null), 1_000);
    return () => clearInterval(timer);
  }, [cooldown !== null]);

  const sendCode = async (captchaId: string, captchaAnswer: string) => {
    setShowCaptcha(false);
    setSending(true);
    setError('');
    try {
      const result = await authService.sendVerificationCode(token, { captchaId, captchaAnswer });
      setCodeSent(true);
      setCooldown(result.cooldown || 60);
      setCode(Array<string>(6).fill(''));
    } catch (caught) {
      setError(toApiError(caught, 'Failed to send verification code').message);
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    const value = code.join('');
    if (value.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await authService.verifyEmail(token, value);
      setVerified(true);
      setTimeout(() => navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] }), 1_500);
    } catch (caught) {
      setError(toApiError(caught, 'Verification failed').message);
    } finally {
      setLoading(false);
    }
  };

  const footer = <AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />;

  if (tokenValid === null) {
    return <AuthScaffold footer={footer} subtitle="Validating access..." title="Verify Your Email"><Button fullWidth loading>Validating...</Button></AuthScaffold>;
  }
  if (!tokenValid) {
    return (
      <AuthScaffold footer={footer} title="Invalid Access">
        <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View>
        <Button fullWidth onPress={() => navigation.replace('Register')}>Go to Register</Button>
      </AuthScaffold>
    );
  }
  if (verified) {
    return (
      <AuthScaffold footer={footer} title="Email Verified!">
        <Text style={authStyles.muted}>Your email has been successfully verified.</Text>
        <Text style={authStyles.link}>Redirecting to login...</Text>
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      footer={footer}
      subtitle={codeSent ? 'Enter the 6-digit code sent to your email' : 'Click below to send a verification code to your email'}
      title={codeSent ? 'Enter Verification Code' : 'Verify Your Email'}
    >
      {email ? <Text style={authStyles.link}>{email}</Text> : null}
      {codeSent ? <OtpInput disabled={loading} onChange={(next) => { setCode(next); setError(''); }} value={code} /> : null}
      {error ? <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View> : null}
      {codeSent ? (
        <Button fullWidth loading={loading} onPress={() => void verify()}>{loading ? 'Verifying...' : 'Verify Email'}</Button>
      ) : (
        <Button fullWidth loading={sending} onPress={() => setShowCaptcha(true)}>{sending ? 'Sending...' : 'Send Verification Code'}</Button>
      )}
      <View style={authStyles.inline}>
        {codeSent ? (
          <>
            <Pressable disabled={sending || cooldown !== null} onPress={() => setShowCaptcha(true)}>
              <Text style={authStyles.link}>{cooldown !== null ? `Resend in ${cooldown}s` : sending ? 'Sending...' : 'Resend Code'}</Text>
            </Pressable>
            <Text style={authStyles.divider}>|</Text>
          </>
        ) : null}
        <Pressable onPress={() => navigation.navigate('SignIn')}><Text style={authStyles.link}>Back to Login</Text></Pressable>
      </View>
      <CaptchaModal onClose={() => setShowCaptcha(false)} onVerified={sendCode} visible={showCaptcha} />
    </AuthScaffold>
  );
}
