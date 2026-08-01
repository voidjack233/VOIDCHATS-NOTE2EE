import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export function AuthFooter({ onTerms, onPrivacy }: { onTerms: () => void; onPrivacy: () => void }) {
  return (
    <View style={styles.row}>
      <Pressable onPress={onTerms}><Text style={styles.link}>Terms of Use</Text></Pressable>
      <Text style={styles.slash}>/</Text>
      <Pressable onPress={onPrivacy}><Text style={styles.link}>Privacy Policy</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', flexDirection: 'row', gap: 14 },
  link: { color: '#6b7280', fontSize: 12 },
  slash: { color: '#374151', fontSize: 12 },
});
