/**
 * Aurora RDS Data API wrapper used by both the backend Lambda and agent.
 *
 * All queries go through the RDS Data API (never a direct TCP connection),
 * which is required for Lambda functions that cannot sit inside the Aurora VPC.
 * Uses `formatRecordsAs: "JSON"` — results come back as a JSON string in
 * `formattedRecords`, not as typed record arrays; this module parses that string
 * automatically so callers receive plain typed arrays.
 *
 * Throws at call time if DB_CLUSTER_ARN, DB_SECRET_ARN, or DB_NAME are missing.
 */
import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";

const client = new RDSDataClient({ region: process.env.AWS_REGION ?? "eu-west-1" });

// Auto-apply typeHint UUID to any param whose name is "id" or ends in "Id" / "_id".
// Aurora Data API sends stringValue as `text`; Postgres uuid columns require the hint
// to avoid "operator does not exist: uuid = text".
function applyTypeHints(params: SqlParameter[]): SqlParameter[] {
  return params.map((p) =>
    p.value?.stringValue !== undefined && /^(id$|.*Id$|.*_id$)/.test(p.name ?? "")
      ? { ...p, typeHint: "UUID" }
      : p,
  );
}

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
 * Run a SELECT (or any statement that returns rows) and return all rows as
 * typed objects. Returns an empty array when the result set is empty.
 *
 * @param sql Parameterised SQL with `:name` placeholders.
 * @param parameters RDS Data API `SqlParameter[]` bound to the placeholders.
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
      parameters: applyTypeHints(parameters),
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
      parameters: applyTypeHints(parameters),
    }),
  );
}
