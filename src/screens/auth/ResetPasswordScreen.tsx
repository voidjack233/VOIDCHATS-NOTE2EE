import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AuthFooter } from '../../components/auth/AuthFooter';
import { AuthScaffold } from '../../components/auth/AuthScaffold';
import { Button } from '../../components/common/Button';
import { TextField } from '../../components/common/TextField';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { validateAccountPassword } from '../../utils/passwordPolicy';
import { authStyles } from './authStyles';

type Props = NativeStackScreenProps<RootStackParamList, 'ResetPassword'>;

export function ResetPasswordScreen({ navigation, route }: Props) {
  const token = route.params?.token || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validating, setValidating] = useState(true);
  const [valid, setValid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!token) {
      setError('Reset token is missing');
      setValidating(false);
      return;
    }
    void authService.checkResetToken(token).then(() => {
      if (active) setValid(true);
    }).catch((caught) => {
      if (active) setError(toApiError(caught, 'Invalid or expired reset link').message);
    }).finally(() => {
      if (active) setValidating(false);
    });
    return () => { active = false; };
  }, [token]);

  const submit = async () => {
    if (!token) {
      setError('Reset token is missing');
      return;
    }
    const passwordError = validateAccountPassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await authService.resetPassword(token, password);
      setSuccess(true);
      setTimeout(() => navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] }), 5_000);
    } catch (caught) {
      setError(toApiError(caught, 'Password reset failed').message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthScaffold
      footer={<AuthFooter onPrivacy={() => navigation.navigate('Legal', { document: 'privacy' })} onTerms={() => navigation.navigate('Legal', { document: 'terms' })} />}
      subtitle="Enter your new password below"
      title="Reset Password"
    >
      {validating ? <Button fullWidth loading>Validating...</Button> : success ? (
        <View style={authStyles.successBox}><Text style={authStyles.success}>Password reset successfully! Redirecting...</Text></View>
      ) : !valid ? (
        <>
          <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View>
          <Button fullWidth onPress={() => navigation.replace('SignIn')} variant="secondary">Back to Login</Button>
        </>
      ) : (
        <>
          <View style={authStyles.fields}>
            <TextField label="New Password" onChangeText={(value) => { setPassword(value.replace(/ /g, '')); setError(''); }} secureTextEntry textContentType="newPassword" value={password} />
            <TextField label="Confirm New Password" onChangeText={(value) => { setConfirmPassword(value.replace(/ /g, '')); setError(''); }} onSubmitEditing={() => void submit()} secureTextEntry textContentType="newPassword" value={confirmPassword} />
          </View>
          {error ? <View style={authStyles.errorBox}><Text style={authStyles.error}>{error}</Text></View> : null}
          <Button fullWidth loading={loading} onPress={() => void submit()}>{loading ? 'Resetting...' : 'Reset Password'}</Button>
        </>
      )}
    </AuthScaffold>
  );
}
