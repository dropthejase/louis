/**
 * Aurora RDS Data API wrapper for the conversion Lambda.
 *
 * Structurally identical to the backend and agent copies — each Lambda package
 * is bundled independently so this cannot be a shared import. Uses
 * `formatRecordsAs: "JSON"` and parses `formattedRecords` automatically.
 */
import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";

const client = new RDSDataClient({ region: process.env.AWS_REGION ?? "eu-west-1" });

function getConfig() {
  const resourceArn = process.env.DB_CLUSTER_ARN;
  const secretArn = process.env.DB_SECRET_ARN;
  const database = process.env.DB_NAME;
  if (!resourceArn || !secretArn || !database) {
    throw new Error("DB_CLUSTER_ARN, DB_SECRET_ARN, DB_NAME must be set");
  }
  return { resourceArn, secretArn, database };
}

/** Run a SELECT and return all rows. Returns [] when the result set is empty. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  parameters: SqlParameter[] = [],
): Promise<T[]> {
  const config = getConfig();
  const result = await client.send(
    new ExecuteStatementCommand({
      ...config,
      sql,
      parameters,
      formatRecordsAs: "JSON",
    }),
  );
  if (!result.formattedRecords) return [];
  return JSON.parse(result.formattedRecords) as T[];
}

/** Like `query` but returns the first row or null when the result set is empty. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  parameters: SqlParameter[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, parameters);
  return rows[0] ?? null;
}

/** Run an INSERT/UPDATE/DELETE. Result rows are discarded. */
export async function execute(
  sql: string,
  parameters: SqlParameter[] = [],
): Promise<void> {
  const config = getConfig();
  await client.send(
    new ExecuteStatementCommand({
      ...config,
      sql,
      parameters,
    }),
  );
}
