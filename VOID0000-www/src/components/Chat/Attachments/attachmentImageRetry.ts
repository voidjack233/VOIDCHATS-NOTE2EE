import type { AttachmentRenderSource } from '../../../Services/Chat/attachmentRenderPolicy';

type SourceKind = AttachmentRenderSource['kind'];

interface SourceFailure {
  kind: SourceKind;
  url: string;
}

export interface AttachmentImageAttemptState {
  attachmentIdentity: string;
  failures: SourceFailure[];
}

export function createAttachmentImageAttemptState(
  attachmentIdentity: string,
): AttachmentImageAttemptState {
  return {
    attachmentIdentity,
    failures: [],
  };
}

function getActiveState(
  state: AttachmentImageAttemptState,
  attachmentIdentity: string,
): AttachmentImageAttemptState {
  return state.attachmentIdentity === attachmentIdentity
    ? state
    : createAttachmentImageAttemptState(attachmentIdentity);
}

export function selectAttachmentImageSource(
  state: AttachmentImageAttemptState,
  attachmentIdentity: string,
  sources: AttachmentRenderSource[],
): AttachmentRenderSource | null {
  const activeState = getActiveState(state, attachmentIdentity);

  for (const source of sources) {
    const failuresForKind = activeState.failures.filter(
      (failure) => failure.kind === source.kind,
    );
    if (failuresForKind.some((failure) => failure.url === source.url)) {
      continue;
    }

    // One initial URL plus one genuinely different refreshed URL per source.
    if (failuresForKind.length >= 2) {
      continue;
    }
    return source;
  }

  return null;
}

export function recordAttachmentImageFailure(
  state: AttachmentImageAttemptState,
  attachmentIdentity: string,
  source: AttachmentRenderSource,
): AttachmentImageAttemptState {
  const activeState = getActiveState(state, attachmentIdentity);
  const alreadyFailed = activeState.failures.some((failure) => (
    failure.kind === source.kind && failure.url === source.url
  ));
  const failuresForKind = activeState.failures.filter(
    (failure) => failure.kind === source.kind,
  );
  if (alreadyFailed || failuresForKind.length >= 2) {
    return activeState;
  }

  return {
    ...activeState,
    failures: [...activeState.failures, source],
  };
}

export function recordAttachmentImageSuccess(
  state: AttachmentImageAttemptState,
  attachmentIdentity: string,
  source: AttachmentRenderSource,
): AttachmentImageAttemptState {
  const activeState = getActiveState(state, attachmentIdentity);
  if (!activeState.failures.some((failure) => failure.kind === source.kind)) {
    return activeState;
  }

  return {
    ...activeState,
    failures: activeState.failures.filter(
      (failure) => failure.kind !== source.kind,
    ),
  };
}
