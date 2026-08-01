import { RefreshCw, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { authService } from '../../services/auth';
import { useTheme } from '../../theme/ThemeContext';
import { Button } from '../common/Button';
import { TextField } from '../common/TextField';

interface CaptchaModalProps {
  visible: boolean;
  onClose: () => void;
  onVerified: (captchaId: string, captchaAnswer: string) => void | Promise<void>;
}

export function CaptchaModal({ visible, onClose, onVerified }: CaptchaModalProps) {
  const { palette } = useTheme();
  const [image, setImage] = useState<string | null>(null);
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadCaptcha = useCallback(async () => {
    setLoading(true);
    setAnswer('');
    setError('');
    try {
      const data = await authService.generateCaptcha();
      setImage(data.image);
      setCaptchaId(data.captchaId);
    } catch {
      setImage(null);
      setCaptchaId(null);
      setError('Failed to load captcha');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void loadCaptcha();
  }, [loadCaptcha, visible]);

  const submit = async () => {
    if (!captchaId || !answer.trim()) {
      setError('Please enter the characters');
      return;
    }
    await onVerified(captchaId, answer.trim());
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={[styles.backdrop, { backgroundColor: palette.overlay }]}>
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: palette.text }]}>Security Check</Text>
            <Pressable accessibilityLabel="Close" hitSlop={10} onPress={onClose}>
              <X size={20} color={palette.muted} />
            </Pressable>
          </View>
          <View style={styles.captchaRow}>
            <View style={[styles.imageFrame, { backgroundColor: palette.surfaceRaised, borderColor: palette.border }]}>
              {loading ? <ActivityIndicator color={palette.accent} /> : image ? (
                <Image resizeMode="contain" source={{ uri: image }} style={styles.image} />
              ) : <Text style={{ color: palette.muted }}>Failed to load</Text>}
            </View>
            <Pressable
              accessibilityLabel="Refresh captcha"
              disabled={loading}
              onPress={() => void loadCaptcha()}
              style={[styles.refresh, { backgroundColor: palette.surfaceRaised, borderColor: palette.border }]}
            >
              <RefreshCw size={20} color={palette.muted} />
            </Pressable>
          </View>
          <TextField
            autoCapitalize="characters"
            autoCorrect={false}
            error={error}
            onChangeText={(text) => { setAnswer(text); setError(''); }}
            onSubmitEditing={() => void submit()}
            placeholder="Enter the characters above"
            returnKeyType="done"
            style={styles.answer}
            value={answer}
          />
          <Button disabled={loading || !answer.trim()} fullWidth onPress={() => void submit()}>
            Verify
          </Button>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: 20 },
  card: { borderRadius: 18, borderWidth: 1, gap: 16, padding: 20 },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: '700' },
  captchaRow: { flexDirection: 'row', gap: 10 },
  imageFrame: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flex: 1, height: 80, justifyContent: 'center', overflow: 'hidden' },
  image: { height: 80, width: '100%' },
  refresh: { alignItems: 'center', borderRadius: 10, borderWidth: 1, justifyContent: 'center', width: 52 },
  answer: { letterSpacing: 3, textAlign: 'center' },
});
