interface HistoryLogicalRangeGeometryInput {
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  hasOlder: boolean;
  hasNewer: boolean;
  historyLogicalSlotHeight: number;
}

export const resolveHistoryLogicalRangeGeometry = ({
  topSpacerHeight,
  bottomSpacerHeight,
  hasOlder,
  hasNewer,
  historyLogicalSlotHeight,
}: HistoryLogicalRangeGeometryInput) => {
  const topTrimmedSpacerHeight = hasOlder ? Math.max(0, topSpacerHeight) : 0;
  const bottomTrimmedSpacerHeight = Math.max(0, bottomSpacerHeight);
  const topEstimatedLoadingHeight = hasOlder && topTrimmedSpacerHeight <= 1
    ? historyLogicalSlotHeight
    : 0;
  const bottomEstimatedLoadingHeight = hasNewer && bottomTrimmedSpacerHeight <= 1
    ? historyLogicalSlotHeight
    : 0;

  return {
    topTrimmedSpacerHeight,
    bottomTrimmedSpacerHeight,
    topEstimatedLoadingHeight,
    bottomEstimatedLoadingHeight,
    topLogicalRangeHeight: topTrimmedSpacerHeight + topEstimatedLoadingHeight,
    bottomLogicalRangeHeight: bottomTrimmedSpacerHeight + bottomEstimatedLoadingHeight,
  };
};
