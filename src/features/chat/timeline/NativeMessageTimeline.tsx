import {
  FlashList,
  type FlashListRef,
  type ListRenderItemInfo,
} from '@shopify/flash-list';
import { ArrowDown } from 'lucide-react-native';
import {
  forwardRef,
  type ForwardedRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {
  NativeMessageTimelineHandle,
  NativeMessageTimelineProps,
  TimelineMessage,
} from './timelineTypes';
import { useNativeTimelineController } from './useNativeTimelineController';

const VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 1,
  minimumViewTime: 40,
} as const;

type NativeMessageTimelineInstanceProps = NativeMessageTimelineProps & {
  timelineRef: ForwardedRef<NativeMessageTimelineHandle>;
};

function NativeMessageTimelineInstance({
  timelineRef,
  conversationId: _conversationId,
  messages,
  currentUserId,
  colors,
  renderMessage,
  getItemType,
  initialDataReady,
  initialScrollToStart = false,
  hasOlder,
  hasNewer = false,
  loadingOlder = false,
  loadingNewer = false,
  loadOlder,
  loadNewer,
  loadLatest,
  shouldForceFollowOnAppend,
  onLoadError,
  onVisibleRangeChange,
  onStateChange,
  listHeader,
  emptyComponent,
  emptyLabel = 'No messages yet',
  testID,
}: NativeMessageTimelineInstanceProps) {
  const listRef = useRef<FlashListRef<TimelineMessage>>(null);
  const controller = useNativeTimelineController({
    currentUserId,
    initialDataReady,
    initialScrollToStart,
    hasNewer,
    hasOlder,
    listRef,
    loadNewer,
    loadLatest,
    loadOlder,
    loadingNewer,
    loadingOlder,
    messages,
    onLoadError,
    onStateChange,
    onVisibleRangeChange,
    shouldForceFollowOnAppend,
  });

  useImperativeHandle(
    timelineRef,
    () => ({
      getState: () => controller.stateRef.current,
      jumpToMessage: controller.jumpToMessage,
      jumpToPresent: controller.jumpToPresent,
      loadOlder: controller.requestOlder,
    }),
    [controller],
  );

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TimelineMessage>) => {
      const highlighted = controller.state.highlightedMessageId === item.id;
      return (
        <View
          style={
            highlighted
              ? { backgroundColor: `${colors.accent}24` }
              : undefined
          }>
          {renderMessage({
            message: item,
            index,
            highlighted,
          })}
        </View>
      );
    },
    [
      colors.accent,
      controller.state.highlightedMessageId,
      renderMessage,
    ],
  );

  const itemType = useCallback(
    (message: TimelineMessage) =>
      getItemType?.(message) ?? message.itemType ?? 'message',
    [getItemType],
  );

  const extraData = useMemo(
    () => ({ highlightedMessageId: controller.state.highlightedMessageId }),
    [controller.state.highlightedMessageId],
  );
  // FlashList owns prepend anchoring; the controller does not counter-scroll history updates.
  const maintainVisibleContentPosition = useMemo(() => ({
    animateAutoScrollToBottom: true,
    autoscrollToBottomThreshold: 0.04,
    startRenderingFromBottom: !initialScrollToStart,
  }), [initialScrollToStart]);
  const historyHeader = useMemo(() => {
    if (loadingOlder) {
      return (
        <View pointerEvents="none" style={styles.historyLoading}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      );
    }
    return hasOlder ? null : listHeader ? <>{listHeader}</> : null;
  }, [colors.accent, hasOlder, listHeader, loadingOlder]);

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
      testID={testID}>
      <FlashList
        ref={listRef}
        contentContainerStyle={styles.contentContainer}
        data={messages}
        drawDistance={600}
        extraData={extraData}
        getItemType={itemType}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        ListHeaderComponent={historyHeader}
        ListEmptyComponent={
          emptyComponent ? <>{emptyComponent}</> : (
            <View style={styles.empty}>
              <Text style={[styles.emptyText, { color: colors.text }]}>
                {emptyLabel}
              </Text>
            </View>
          )
        }
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        onContentSizeChange={controller.onContentSizeChange}
        onEndReached={controller.onEndReached}
        onEndReachedThreshold={0.2}
        onLayout={controller.onLayout}
        onLoad={controller.onLoad}
        onScroll={controller.onScroll}
        onScrollBeginDrag={controller.onScrollBeginDrag}
        onStartReached={
          controller.state.initialPositionComplete
            ? controller.onStartReached
            : undefined
        }
        onStartReachedThreshold={0.25}
        onViewableItemsChanged={controller.onViewableItemsChanged}
        renderItem={renderItem}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator
        viewabilityConfig={VIEWABILITY_CONFIG}
      />

      {controller.state.showJumpToPresent ? (
        <View pointerEvents="box-none" style={styles.jumpWrap}>
          <Pressable
            accessibilityLabel="Jump to latest messages"
            accessibilityRole="button"
            disabled={loadingNewer}
            hitSlop={8}
            onPress={() => void controller.jumpToPresent({ animated: true })}
            style={({ pressed }) => [
              styles.jumpButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
              loadingNewer && styles.disabledButton,
              pressed && styles.pressedButton,
            ]}>
            {loadingNewer ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <ArrowDown color={colors.text} size={19} />
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export const NativeMessageTimeline = forwardRef<
  NativeMessageTimelineHandle,
  NativeMessageTimelineProps
>((props, ref) => (
  <NativeMessageTimelineInstance
    key={props.conversationId}
    {...props}
    timelineRef={ref}
  />
));

NativeMessageTimeline.displayName = 'NativeMessageTimeline';

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 8,
    paddingTop: 8,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 180,
    padding: 24,
  },
  emptyText: {
    fontSize: 14,
  },
  historyLoading: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 10,
  },
  jumpButton: {
    alignItems: 'center',
    borderRadius: 23,
    borderWidth: 1,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  jumpWrap: {
    alignItems: 'center',
    bottom: 12,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  pressedButton: {
    opacity: 0.72,
  },
  disabledButton: {
    opacity: 0.52,
  },
});
