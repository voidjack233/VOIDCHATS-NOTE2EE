import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Globe,
  Laptop,
  Monitor,
  Shield,
  Smartphone,
  Tablet,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import type { RootStackParamList } from '../../navigation/types';
import { toApiError } from '../../services/api';
import { authService } from '../../services/auth';
import { useTheme } from '../../theme/ThemeContext';
import type { Session } from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'ActiveSessions'>;

interface DeviceInfo {
  browser: string;
  os: string;
  kind: 'phone' | 'tablet' | 'desktop' | 'unknown';
}

const parseUserAgent = (userAgent: string | null): DeviceInfo => {
  if (!userAgent) return { browser: 'Unknown Browser', os: 'Unknown OS', kind: 'unknown' };

  const isTablet = /tablet|ipad/i.test(userAgent);
  const isPhone = !isTablet && /mobile|android|iphone/i.test(userAgent);
  const browserMatch = userAgent.match(/(Chrome|Firefox|Safari|Edge|Edg|Opera|Brave)\/[\d.]+/i);
  const osMatch = userAgent.match(/(Windows|Mac OS|Macintosh|Linux|Android|iOS|iPhone|iPad)/i);

  return {
    browser: browserMatch?.[1]?.replace(/^Edg$/i, 'Edge') || 'Unknown Browser',
    os: osMatch?.[1] || 'Unknown OS',
    kind: isTablet ? 'tablet' : isPhone ? 'phone' : 'desktop',
  };
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  const now = Date.now();
  const difference = Math.max(0, now - date.getTime());
  const minutes = Math.floor(difference / 60_000);
  const hours = Math.floor(difference / 3_600_000);
  const days = Math.floor(difference / 86_400_000);

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function SessionsScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      setSessions(await authService.sessions());
    } catch (caught) {
      setError(toApiError(caught, 'Failed to load sessions').message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeSession = async (sessionId: string) => {
    setRevoking(sessionId);
    setActionError('');
    try {
      await authService.revokeSession(sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
    } catch (caught) {
      setActionError(toApiError(caught, 'Failed to revoke session').message);
    } finally {
      setRevoking(null);
    }
  };

  const revokeAllSessions = async () => {
    setRevoking('__all__');
    setActionError('');
    try {
      await authService.revokeAllSessions();
      setSessions((current) => current.filter((session) => session.is_current));
    } catch (caught) {
      setActionError(toApiError(caught, 'Failed to revoke sessions').message);
    } finally {
      setRevoking(null);
    }
  };

  const confirmRevokeAll = () => {
    Alert.alert(
      'Revoke all other sessions?',
      'Every other signed-in device or browser will need to log in again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke all', style: 'destructive', onPress: () => void revokeAllSessions() },
      ],
    );
  };

  if (loading) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} subtitle="One entry per signed-in device or browser." title="Active Sessions" />
        <StateView title="Loading sessions" type="loading" />
      </Screen>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} subtitle="One entry per signed-in device or browser." title="Active Sessions" />
        <StateView
          actionLabel="Retry"
          message={error}
          onAction={() => void load()}
          title="Connection Error"
          type="error"
        />
      </Screen>
    );
  }

  const currentSession = sessions.find((session) => session.is_current);
  const otherSessions = sessions.filter((session) => !session.is_current);

  return (
    <Screen>
      <AppHeader onBack={() => navigation.goBack()} subtitle="One entry per signed-in device or browser." title="Active Sessions" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            colors={[palette.accent]}
            onRefresh={() => void load(true)}
            refreshing={refreshing}
            tintColor={palette.accent}
          />
        }
      >
        {actionError ? <FeedbackBanner message={actionError} onDismiss={() => setActionError('')} /> : null}
        {error ? <FeedbackBanner message={error} onDismiss={() => setError('')} /> : null}

        {sessions.length === 0 ? (
          <StateView
            compact
            message="No signed-in devices or browsers were returned."
            title="No active sessions"
            type="empty"
          />
        ) : (
          <>
            {currentSession ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: palette.muted }]}>Current session</Text>
                <SessionCard current session={currentSession} />
              </View>
            ) : null}

            {otherSessions.length ? (
              <View style={styles.section}>
                <View style={styles.sectionHeading}>
                  <Text style={[styles.sectionTitle, { color: palette.muted }]}>Other sessions ({otherSessions.length})</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={revoking !== null}
                    onPress={confirmRevokeAll}
                    style={({ pressed }) => [
                      styles.revokeAll,
                      { backgroundColor: `${palette.danger}15`, opacity: revoking !== null ? 0.5 : pressed ? 0.72 : 1 },
                    ]}
                  >
                    <Text style={[styles.revokeAllText, { color: palette.danger }]}>
                      {revoking === '__all__' ? 'Revoking...' : 'Revoke all'}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.cards}>
                  {otherSessions.map((session) => (
                    <SessionCard
                      disabled={revoking !== null}
                      key={session.id}
                      onRevoke={() => void revokeSession(session.id)}
                      revoking={revoking === session.id}
                      session={session}
                    />
                  ))}
                </View>
              </View>
            ) : (
              <View style={[
                styles.emptyCard,
                { backgroundColor: palette.surface, borderColor: palette.border },
              ]}>
                <Shield color={palette.muted} size={42} />
                <Text style={[styles.emptyTitle, { color: palette.text }]}>No other active sessions</Text>
                <Text style={[styles.emptyMessage, { color: palette.muted }]}>Only this device or browser is currently signed in.</Text>
              </View>
            )}
          </>
        )}

        <Text style={[styles.expiry, { color: palette.muted }]}>Sessions expire after 7 days of inactivity</Text>
      </ScrollView>
    </Screen>
  );
}

function SessionCard({
  session,
  current = false,
  onRevoke,
  revoking = false,
  disabled = false,
}: {
  session: Session;
  current?: boolean;
  onRevoke?: () => void;
  revoking?: boolean;
  disabled?: boolean;
}) {
  const { palette } = useTheme();
  const parsed = parseUserAgent(session.user_agent);
  const type = (session.device_type || '').toLowerCase();
  const kind = type.includes('tablet')
    ? 'tablet'
    : type.includes('phone') || type.includes('mobile')
      ? 'phone'
      : type.includes('desktop') || type.includes('laptop')
        ? 'desktop'
        : parsed.kind;
  const Icon = kind === 'phone'
    ? Smartphone
    : kind === 'tablet'
      ? Tablet
      : kind === 'desktop'
        ? Laptop
        : Monitor;
  const deviceLabel = session.device_name?.trim() || `${parsed.browser} on ${parsed.os}`;

  return (
    <View style={[
      styles.card,
      {
        backgroundColor: current ? `${palette.success}12` : palette.surface,
        borderColor: current ? `${palette.success}66` : palette.border,
      },
    ]}>
      <View style={[
        styles.deviceIcon,
        { backgroundColor: current ? `${palette.success}18` : palette.hover },
      ]}>
        <Icon color={current ? palette.success : palette.muted} size={21} />
      </View>
      <View style={styles.cardCopy}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} style={[styles.deviceName, { color: palette.text }]}>{deviceLabel}</Text>
          {current ? (
            <View style={[styles.badge, { backgroundColor: `${palette.success}20` }]}>
              <Text style={[styles.badgeText, { color: palette.success }]}>Current</Text>
            </View>
          ) : session.is_recently_active ? (
            <View style={[styles.badge, { backgroundColor: `${palette.accent}20` }]}>
              <Text style={[styles.badgeText, { color: palette.accent }]}>Recent</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          <Globe color={palette.faint} size={13} />
          <Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{session.ip_address || 'Unknown IP'}</Text>
        </View>
        <Text style={[styles.meta, { color: palette.muted }]}>Created {formatDate(session.created_at)}</Text>
        <Text style={[styles.meta, { color: palette.muted }]}>Last active {formatDate(session.updated_at)}</Text>
      </View>
      {!current && onRevoke ? (
        <Pressable
          accessibilityLabel={`Revoke session for ${deviceLabel}`}
          accessibilityRole="button"
          disabled={disabled}
          onPress={onRevoke}
          style={({ pressed }) => [
            styles.revoke,
            { backgroundColor: `${palette.danger}15`, opacity: disabled ? 0.45 : pressed ? 0.72 : 1 },
          ]}
        >
          <Text style={[styles.revokeText, { color: palette.danger }]}>{revoking ? '...' : 'Revoke'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: 24, padding: 18, paddingBottom: 36 },
  section: { gap: 10 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 13, fontWeight: '700' },
  cards: { gap: 10 },
  revokeAll: { borderRadius: 9, paddingHorizontal: 11, paddingVertical: 7 },
  revokeAllText: { fontSize: 12, fontWeight: '800' },
  card: { alignItems: 'flex-start', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 11, padding: 14 },
  deviceIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  cardCopy: { flex: 1, minWidth: 0 },
  nameRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  deviceName: { flexShrink: 1, fontSize: 14, fontWeight: '800' },
  badge: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontWeight: '800' },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 7 },
  meta: { fontSize: 11, lineHeight: 17 },
  revoke: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7 },
  revokeText: { fontSize: 11, fontWeight: '800' },
  emptyCard: { alignItems: 'center', borderRadius: 16, borderWidth: 1, padding: 26 },
  emptyTitle: { fontSize: 15, fontWeight: '800', marginTop: 12 },
  emptyMessage: { fontSize: 12, lineHeight: 18, marginTop: 5, textAlign: 'center' },
  expiry: { fontSize: 11, marginTop: 'auto', paddingTop: 8, textAlign: 'center' },
});
