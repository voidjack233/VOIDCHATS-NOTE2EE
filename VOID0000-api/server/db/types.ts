import type { QueryResult, QueryResultRow } from 'pg';

export interface DatabaseQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}
