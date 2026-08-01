import { StyleSheet } from 'react-native';

export const authStyles = StyleSheet.create({
  fields: { gap: 16 },
  link: { color: '#60a5fa', fontSize: 14, fontWeight: '600' },
  inline: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  muted: { color: '#9ca3af', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  errorBox: { backgroundColor: 'rgba(127,29,29,0.22)', borderColor: 'rgba(185,28,28,0.5)', borderRadius: 10, borderWidth: 1, padding: 12 },
  error: { color: '#fca5a5', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  successBox: { backgroundColor: 'rgba(6,78,59,0.25)', borderColor: 'rgba(4,120,87,0.5)', borderRadius: 10, borderWidth: 1, padding: 12 },
  success: { color: '#6ee7b7', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  divider: { color: '#4b5563', paddingHorizontal: 8 },
});
