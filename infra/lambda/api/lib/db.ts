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

const AURORA_RESUME_RE = /resuming after being auto-paused/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [5000, 10000, 20000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (AURORA_RESUME_RE.test(err?.message ?? '') && attempt < delays.length) {
        await sleep(delays[attempt]);
      } else {
        throw err;
      }
    }
  }
  throw new Error('unreachable');
}

// Auto-apply typeHint UUID to params whose name ends in Id/_id and whose
// value is a well-formed UUID. Params in TEXT_ID_PARAMS are Cognito subs or
// other text fields that look like UUIDs but are stored as text — skip them.
const TEXT_ID_PARAMS = new Set(['userId', 'user_id', 'userEmail', 'email', 'sharedByUserId', 'shared_by_user_id']);
const UUID_NAME_RE = /^(id$|.*Id$|.*_id$)/;
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function applyTypeHints(params: SqlParameter[]): SqlParameter[] {
  return params.map((p) => {
    const name = p.name ?? '';
    const val = p.value?.stringValue;
    if (
      val !== undefined &&
      !TEXT_ID_PARAMS.has(name) &&
      UUID_NAME_RE.test(name) &&
      UUID_VALUE_RE.test(val)
    ) {
      return { ...p, typeHint: 'UUID' };
    }
    return p;
  });
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
  const result = await withRetry(() => client.send(
    new ExecuteStatementCommand({
      ...config,
      sql,
      parameters: applyTypeHints(parameters),
      formatRecordsAs: "JSON",
    }),
  ));
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
  await withRetry(() => client.send(
    new ExecuteStatementCommand({
      ...config,
      sql,
      parameters: applyTypeHints(parameters),
    }),
  ));
}
