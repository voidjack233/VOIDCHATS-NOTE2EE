export const MESSAGE_IMAGE_MAX_WIDTH = 280;
export const MESSAGE_IMAGE_MAX_HEIGHT = 320;
export const MESSAGE_IMAGE_FALLBACK_WIDTH = 240;
export const MESSAGE_IMAGE_FALLBACK_HEIGHT = 180;

// Screen row padding, the incoming avatar gutter, bubble padding/border, and a
// small safety margin. Using the incoming-message footprint also keeps outgoing
// image sizing consistent while guaranteeing that the bubble fits on screen.
export const MESSAGE_IMAGE_HORIZONTAL_RESERVE = 88;

export interface MessageImageGeometry {
  width: number;
  height: number;
}

function positiveFiniteNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function fitInside(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
): MessageImageGeometry {
  const scale = Math.min(
    1,
    maxWidth / sourceWidth,
    MESSAGE_IMAGE_MAX_HEIGHT / sourceHeight,
  );

  return {
    width: Math.min(maxWidth, Math.max(1, Math.round(sourceWidth * scale))),
    height: Math.min(
      MESSAGE_IMAGE_MAX_HEIGHT,
      Math.max(1, Math.round(sourceHeight * scale)),
    ),
  };
}

export function calculateMessageImageGeometry(
  attachmentWidth: unknown,
  attachmentHeight: unknown,
  viewportWidth: number,
): MessageImageGeometry {
  const safeViewportWidth = positiveFiniteNumber(viewportWidth)
    ?? MESSAGE_IMAGE_MAX_WIDTH + MESSAGE_IMAGE_HORIZONTAL_RESERVE;
  const maxWidth = Math.max(
    1,
    Math.min(
      MESSAGE_IMAGE_MAX_WIDTH,
      Math.floor(safeViewportWidth - MESSAGE_IMAGE_HORIZONTAL_RESERVE),
    ),
  );
  const sourceWidth = positiveFiniteNumber(attachmentWidth);
  const sourceHeight = positiveFiniteNumber(attachmentHeight);

  if (sourceWidth === null || sourceHeight === null) {
    return fitInside(
      MESSAGE_IMAGE_FALLBACK_WIDTH,
      MESSAGE_IMAGE_FALLBACK_HEIGHT,
      maxWidth,
    );
  }

  return fitInside(sourceWidth, sourceHeight, maxWidth);
}
