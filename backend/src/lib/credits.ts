/**
 * Per-user monthly credit tracking backed by DynamoDB.
 *
 * Each item is keyed on (userId, month) where month is YYYY-MM.
 * The backend checks credits before forwarding a request to the agent (pre-flight 429),
 * while the agent itself increments the counter via its AfterModelCallEvent hook
 * after each model call — these are two distinct operations.
 * MONTHLY_LIMIT is a hard-coded constant; raising it requires a code change.
 */
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const TABLE = process.env.CREDITS_TABLE_NAME!;
const MONTHLY_LIMIT = 100;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function nextMonthFirst(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().split('T')[0];
}

/**
 * Read the current month's usage for a user and return whether they are under
 * the monthly limit.
 *
 * @returns `allowed` — false when the user has reached MONTHLY_LIMIT this month.
 * @returns `resetDate` — ISO date (YYYY-MM-DD) of the first day of next month.
 * @returns `used` — how many credits the user has consumed this month so far.
 */
export async function checkCredits(userId: string): Promise<{ allowed: boolean; resetDate: string; used: number }> {
  const month = currentMonth();
  const resetDate = nextMonthFirst();
  const result = await dynamo.send(new GetItemCommand({
    TableName: TABLE,
    Key: { userId: { S: userId }, month: { S: month } },
  }));
  const used = parseInt(result.Item?.credits_used?.N ?? '0', 10);
  return { allowed: used < MONTHLY_LIMIT, resetDate, used };
}

/**
 * Atomically increment the credit counter for the current month by 1.
 * Called by the agent's AfterModelCallEvent hook — not by the backend route.
 */
export async function incrementCredits(userId: string): Promise<void> {
  const month = currentMonth();
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { userId: { S: userId }, month: { S: month } },
    UpdateExpression: 'ADD credits_used :one',
    ExpressionAttributeValues: { ':one': { N: '1' } },
  }));
}
