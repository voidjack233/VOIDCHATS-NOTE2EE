import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface NativeBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  backdropColor: string;
  sheetStyle?: StyleProp<ViewStyle>;
  closeAccessibilityLabel?: string;
  testID?: string;
}

const OPEN_DURATION_MS = 220;
const CLOSE_DURATION_MS = 180;
const SHEET_EASING = Easing.bezier(0.2, 0.8, 0.2, 1);

export function NativeBottomSheet({
  visible,
  onClose,
  children,
  backdropColor,
  sheetStyle,
  closeAccessibilityLabel = 'Close bottom sheet',
  testID,
}: NativeBottomSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const visibleRef = useRef(visible);
  const contentRef = useRef(children);

  visibleRef.current = visible;
  if (visible) contentRef.current = children;

  useEffect(() => {
    progress.stopAnimation();

    if (visible) {
      if (!mounted) {
        progress.setValue(0);
        setMounted(true);
        return;
      }

      Animated.timing(progress, {
        duration: OPEN_DURATION_MS,
        easing: SHEET_EASING,
        toValue: 1,
        useNativeDriver: true,
      }).start();
      return;
    }

    if (!mounted) return;
    Animated.timing(progress, {
      duration: CLOSE_DURATION_MS,
      easing: SHEET_EASING,
      toValue: 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visibleRef.current) setMounted(false);
    });
  }, [mounted, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [Math.max(windowHeight, 1), 0],
  });

  return (
    <Modal
      animationType="none"
      hardwareAccelerated
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible>
      <Animated.View
        pointerEvents="box-none"
        style={[styles.backdropLayer, { opacity: progress }]}>
        <Pressable
          accessibilityLabel={closeAccessibilityLabel}
          accessibilityRole="button"
          onPress={onClose}
          style={[styles.backdrop, { backgroundColor: backdropColor }]}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          sheetStyle,
          { transform: [{ translateY }] },
        ]}
        testID={testID}>
        {contentRef.current}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  backdropLayer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  sheet: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
