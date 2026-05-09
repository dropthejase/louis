/**
 * Aurora RDS Data API wrapper for the agent Lambda.
 *
 * Identical in structure to backend/src/lib/db.ts — both packages need their
 * own copy because they are bundled independently. Uses `formatRecordsAs: "JSON"`
 * so results are returned as a JSON string in `formattedRecords` and parsed
 * back to typed arrays here. Throws at call time if DB env vars are missing.
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

/**
 * Run a SELECT (or any statement that returns rows) and return all rows.
 * Returns an empty array when the result set is empty.
 */
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

/**
 * Run a statement expected to return at most one row.
 * Returns the first row, or null if the result set is empty.
 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  parameters: SqlParameter[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, parameters);
  return rows[0] ?? null;
}

/**
 * Run an INSERT / UPDATE / DELETE that returns no rows.
 */
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
