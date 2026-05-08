import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const client = new RDSDataClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });

function getConfig() {
  return {
    resourceArn: process.env.DB_CLUSTER_ARN!,
    secretArn: process.env.DB_SECRET_ARN!,
    database: process.env.DB_NAME!,
  };
}

export const handler = async (event: any): Promise<void> => {
  const userId: string | undefined =
    event?.detail?.requestParameters?.username ??
    event?.detail?.requestParameters?.Username;

  if (!userId) {
    console.error('[post-deletion] no userId in event', JSON.stringify(event));
    return;
  }

  await client.send(new ExecuteStatementCommand({
    ...getConfig(),
    sql: `DELETE FROM user_profiles WHERE user_id = :userId`,
    parameters: [{ name: 'userId', value: { stringValue: userId } }],
  }));
};
