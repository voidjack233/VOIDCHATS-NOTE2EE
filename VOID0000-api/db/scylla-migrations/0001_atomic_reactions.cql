CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.reaction_state (
  conversation_id uuid,
  message_id timeuuid,
  user_id uuid,
  emojis set<text>,
  counts map<text, int> static,
  revision bigint static,
  PRIMARY KEY ((conversation_id, message_id), user_id)
);

CREATE TABLE IF NOT EXISTS {{KEYSPACE}}.reaction_schema (
  version text PRIMARY KEY,
  ready boolean
);
