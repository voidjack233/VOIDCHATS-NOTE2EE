import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BellOff, Save, Smartphone, Volume2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import type { RootStackParamList } from '../../navigation/types';
import { playNotificationSound } from '../../services/notificationSound';
import { useTheme } from '../../theme/ThemeContext';

type Props = NativeStackScreenProps<RootStackParamList, 'NotificationsSettings'>;

export function NotificationsScreen({ navigation }: Props) {
  const {
    messageNotificationsEnabled,
    palette,
    saveNotificationPreference,
    setMessageNotificationsEnabled,
  } = useTheme();
  const [savedValue, setSavedValue] = useState(messageNotificationsEnabled);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const changed = messageNotificationsEnabled !== savedValue;

  const saveLocalPreference = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await saveNotificationPreference();
      setSavedValue(messageNotificationsEnabled);
      setFeedback({ kind: 'success', message: 'In-app sound preference saved on this device.' });
    } catch (caught) {
      setFeedback({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Failed to save the local preference.',
      });
    } finally {
      setSaving(false);
    }
  };

  const testSound = async () => {
    setFeedback(null);
    try {
      await playNotificationSound();
    } catch (caught) {
      setFeedback({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Could not play the test sound.',
      });
    }
  };

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} subtitle="Native delivery status and local preferences" title="Notifications" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {feedback ? (
          <FeedbackBanner kind={feedback.kind} message={feedback.message} onDismiss={() => setFeedback(null)} />
        ) : null}

        <View style={[styles.statusCard, { backgroundColor: `${palette.warning}12`, borderColor: `${palette.warning}55` }]}>
          <View style={[styles.iconFrame, { backgroundColor: `${palette.warning}1f` }]}>
            <BellOff color={palette.warning} size={23} />
          </View>
          <View style={styles.statusCopy}>
            <Text style={[styles.cardTitle, { color: palette.text }]}>Native push is not available yet</Text>
            <Text style={[styles.body, { color: palette.muted }]}>The backend currently supports browser Web Push only. This app does not register an APNs, FCM, or Expo push token, so it cannot deliver system notifications while closed or in the background.</Text>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <View style={styles.preferenceRow}>
            <View style={[styles.iconFrame, { backgroundColor: `${palette.accent}1f` }]}>
              <Volume2 color={palette.accent} size={22} />
            </View>
            <View style={styles.preferenceCopy}>
              <Text style={[styles.cardTitle, { color: palette.text }]}>In-app message sounds</Text>
              <Text style={[styles.body, { color: palette.muted }]}>Keep a local preference for message sounds while VOID0000 is open. This does not turn on system push notifications.</Text>
            </View>
            <Switch
              accessibilityLabel="In-app message sounds"
              ios_backgroundColor={palette.hover}
              onValueChange={(enabled) => {
                setFeedback(null);
                setMessageNotificationsEnabled(enabled);
              }}
              thumbColor="#ffffff"
              trackColor={{ false: palette.hover, true: palette.accent }}
              value={messageNotificationsEnabled}
            />
          </View>
        </View>

        <View style={[styles.note, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Smartphone color={palette.muted} size={19} />
          <Text style={[styles.noteText, { color: palette.muted }]}>Native push requires a future token-registration endpoint, user permission flow, and APNs/FCM or Expo delivery service.</Text>
        </View>

        <Button disabled={!changed} fullWidth loading={saving} onPress={() => void saveLocalPreference()}>
          <Save color="#ffffff" size={17} />
          <Text style={styles.saveLabel}>Save on This Device</Text>
        </Button>
        <Button fullWidth onPress={() => void testSound()} variant="secondary">
          <Volume2 color={palette.text} size={17} />
          <Text style={[styles.testLabel, { color: palette.text }]}>Test Sound</Text>
        </Button>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 34 },
  statusCard: { alignItems: 'flex-start', borderRadius: 16, borderWidth: 1, flexDirection: 'row', padding: 16 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16 },
  iconFrame: { alignItems: 'center', borderRadius: 12, height: 44, justifyContent: 'center', width: 44 },
  statusCopy: { flex: 1, marginLeft: 13 },
  cardTitle: { fontSize: 15, fontWeight: '800' },
  body: { fontSize: 12, lineHeight: 18, marginTop: 5 },
  preferenceRow: { alignItems: 'center', flexDirection: 'row' },
  preferenceCopy: { flex: 1, marginHorizontal: 13 },
  note: { alignItems: 'flex-start', borderRadius: 13, borderWidth: 1, flexDirection: 'row', gap: 10, padding: 13 },
  noteText: { flex: 1, fontSize: 12, lineHeight: 18 },
  saveLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  testLabel: { fontSize: 15, fontWeight: '700' },
});
