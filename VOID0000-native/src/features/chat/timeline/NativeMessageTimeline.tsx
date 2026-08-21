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

const MAINTAIN_VISIBLE_POSITION = {
  animateAutoScrollToBottom: false,
  startRenderingFromBottom: true,
} as const;

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
  emptyLabel = 'No messages yet',
  testID,
}: NativeMessageTimelineInstanceProps) {
  const listRef = useRef<FlashListRef<TimelineMessage>>(null);
  const controller = useNativeTimelineController({
    currentUserId,
    initialDataReady,
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
            onHeightWillChange: controller.onItemHeightWillChange,
          })}
        </View>
      );
    },
    [
      colors.accent,
      controller.onItemHeightWillChange,
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
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.text }]}>
              {emptyLabel}
            </Text>
          </View>
        }
        maintainVisibleContentPosition={MAINTAIN_VISIBLE_POSITION}
        onCommitLayoutEffect={controller.onCommitLayoutEffect}
        onContentSizeChange={controller.onContentSizeChange}
        onEndReached={controller.onEndReached}
        onEndReachedThreshold={0.2}
        onLayout={controller.onLayout}
        onLoad={controller.onLoad}
        onMomentumScrollBegin={controller.onMomentumScrollBegin}
        onMomentumScrollEnd={controller.onMomentumScrollEnd}
        onScroll={controller.onScroll}
        onScrollBeginDrag={controller.onScrollBeginDrag}
        onScrollEndDrag={controller.onScrollEndDrag}
        onStartReached={
          controller.state.initialRestoreComplete
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

      {controller.state.isLoadingHistory || loadingOlder ? (
        <View pointerEvents="none" style={styles.loadingOlder}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : null}

      {controller.state.showJumpToPresent ? (
        <Pressable
          accessibilityLabel="Jump to latest messages"
          accessibilityRole="button"
          disabled={loadingNewer}
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
            <ArrowDown color={colors.text} size={17} />
          )}
          <Text style={[styles.jumpButtonText, { color: colors.text }]}>Latest</Text>
        </Pressable>
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
  loadingOlder: {
    alignItems: 'center',
    left: 0,
    paddingTop: 8,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  jumpButton: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    bottom: 12,
    flexDirection: 'row',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 12,
    position: 'absolute',
    right: 12,
  },
  pressedButton: {
    opacity: 0.72,
  },
  disabledButton: {
    opacity: 0.52,
  },
  jumpButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
});
