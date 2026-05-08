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

export async function incrementCredits(userId: string): Promise<void> {
  const month = currentMonth();
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { userId: { S: userId }, month: { S: month } },
    UpdateExpression: 'ADD credits_used :one',
    ExpressionAttributeValues: { ':one': { N: '1' } },
  }));
}
