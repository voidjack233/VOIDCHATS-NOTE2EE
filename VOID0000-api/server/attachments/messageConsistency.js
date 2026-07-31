export const ATTACHMENT_MESSAGE_WRITE_POLICY = 'local_quorum_v1';

export function createAttachmentMessageConsistency({
  scyllaClient,
  cassandraDriver,
} = {}) {
  if (!scyllaClient || typeof scyllaClient.execute !== 'function') {
    throw new TypeError('Attachment message consistency requires a Scylla client');
  }

  const localQuorum = cassandraDriver?.types?.consistencies?.localQuorum;
  if (localQuorum === undefined || localQuorum === null) {
    throw new TypeError('Attachment message consistency requires LOCAL_QUORUM');
  }

  const executeLocalQuorum = (query, parameters) => scyllaClient.execute(
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
