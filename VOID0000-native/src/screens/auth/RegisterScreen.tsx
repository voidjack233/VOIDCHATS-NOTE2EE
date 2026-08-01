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
import { validateAccountPassword } from '../../utils/passwordPolicy';
import { authStyles } from './authStyles';

type Props = NativeStackScreenProps<RootStackParamList, 'Register'>;

export function RegisterScreen({ navigation }: Props) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [captchaRequired, setCaptchaRequired] = useState<boolean | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);

  useEffect(() => {
    void authService.checkCaptchaRequired('register').then((result) => setCaptchaRequired(result.captchaRequired));
  }, []);

  const register = async (captcha?: { captchaId: string; captchaAnswer: string }) => {
    setShowCaptcha(false);
    setLoading(true);
    setError('');
    try {
      const response = await authService.register({ username, email, password, ...captcha });
      if (!response.verificationToken) throw new Error(response.message || 'Registration failed');
      navigation.replace('EmailVerification', { token: response.verificationToken });
    } catch (caught) {
      const apiError = toApiError(caught, 'Registration failed');
      if (apiError.code === 'CAPTCHA_REQUIRED') {
        setCaptchaRequired(true);
        setShowCaptcha(true);
      } else {
        setError(apiError.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const submit = () => {
    const passwordError = validateAccountPassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setError('');
    if (captchaRequired === false) void register();
    else setShowCaptcha(true);
  };

  const sanitize = (setter: (value: string) => void) => (value: string) => {
    setter(value.replace(/ /g, ''));
    setError('');
  };

  return (
    <AuthScaffold
      footer={<AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />}
      subtitle="Join our community"
      title="Create Account"
    >
      <View style={authStyles.fields}>
        <TextField autoCapitalize="none" editable={!loading} label="Username" onChangeText={sanitize(setUsername)} textContentType="username" value={username} />
        <TextField autoCapitalize="none" editable={!loading} keyboardType="email-address" label="Email" onChangeText={sanitize(setEmail)} textContentType="emailAddress" value={email} />
        <TextField autoCapitalize="none" editable={!loading} label="Password" onChangeText={sanitize(setPassword)} secureTextEntry textContentType="newPassword" value={password} />
        <TextField autoCapitalize="none" editable={!loading} label="Confirm Password" onChangeText={sanitize(setConfirmPassword)} onSubmitEditing={submit} secureTextEntry textContentType="newPassword" value={confirmPassword} />
      </View>

      {error ? <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View> : null}

      <View style={authStyles.inline}>
        <Text style={authStyles.muted}>By signing up, you agree to the </Text>
        <Pressable onPress={() => navigation.navigate('Legal', { document: 'terms' })}><Text style={authStyles.link}>Terms</Text></Pressable>
        <Text style={authStyles.muted}> and </Text>
        <Pressable onPress={() => navigation.navigate('Legal', { document: 'privacy' })}><Text style={authStyles.link}>Privacy Policy</Text></Pressable>
        <Text style={authStyles.muted}>.</Text>
      </View>

      <Button fullWidth loading={loading} onPress={submit} variant="success">
        {loading ? 'Creating Account...' : 'Create Account'}
      </Button>

      <View style={authStyles.inline}>
        <Text style={authStyles.muted}>Already have an account? </Text>
        <Pressable onPress={() => navigation.navigate('SignIn')}><Text style={authStyles.link}>Sign in</Text></Pressable>
      </View>

      <CaptchaModal
        onClose={() => setShowCaptcha(false)}
        onVerified={(captchaId, captchaAnswer) => register({ captchaId, captchaAnswer })}
        visible={showCaptcha}
      />
    </AuthScaffold>
  );
}
