export const ATTACHMENT_MESSAGE_WRITE_POLICY = 'local_quorum_v1';

interface AttachmentWriteOptions<Result> {
  insertMessage(): Result | PromiseLike<Result>;
  onInsertSucceeded(): void;
  acknowledgeReservation(): unknown | PromiseLike<unknown>;
}

interface ScyllaConsistencyClient {
  execute(
    query: string,
    parameters: unknown[],
    options: { prepare: true; consistency: number },
  ): Promise<unknown>;
}

interface CassandraConsistencyDriver {
  types?: {
      consistencies?: {
      localQuorum?: number;
    };
  };
}

interface AttachmentMessageConsistencyOptions {
  scyllaClient?: ScyllaConsistencyClient;
  cassandraDriver?: CassandraConsistencyDriver;
}

export async function writeAttachmentMessageWithAcknowledgement<Result>({
  insertMessage,
  onInsertSucceeded,
  acknowledgeReservation,
}: Partial<AttachmentWriteOptions<Result>> = {}): Promise<Result> {
  if (
    typeof insertMessage !== 'function' ||
    typeof onInsertSucceeded !== 'function' ||
    typeof acknowledgeReservation !== 'function'
  ) {
    throw new TypeError('Attachment message write acknowledgement requires lifecycle callbacks');
  }

  const result = await insertMessage();
  onInsertSucceeded();
  await acknowledgeReservation();
  return result;
}

export function createAttachmentMessageConsistency({
  scyllaClient,
  cassandraDriver,
}: AttachmentMessageConsistencyOptions = {}) {
  if (!scyllaClient || typeof scyllaClient.execute !== 'function') {
    throw new TypeError('Attachment message consistency requires a Scylla client');
  }

  const localQuorum = cassandraDriver?.types?.consistencies?.localQuorum;
  if (localQuorum === undefined || localQuorum === null) {
    throw new TypeError('Attachment message consistency requires LOCAL_QUORUM');
  }

  const executeLocalQuorum = (query: string, parameters: unknown[]) => scyllaClient.execute(
    query,
    parameters,
    {
      prepare: true,
      consistency: localQuorum,
    },
  );

  return Object.freeze({
    insert: executeLocalQuorum,
    read: executeLocalQuorum,
    remove: executeLocalQuorum,
  });
}
