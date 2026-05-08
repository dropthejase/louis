import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const client = new RDSDataClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });

function getConfig() {
  return {
    resourceArn: process.env.DB_CLUSTER_ARN!,
    secretArn: process.env.DB_SECRET_ARN!,
    database: process.env.DB_NAME!,
  };
}

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;

  const userId = event.userName;
  const email = event.request.userAttributes['email'] ?? null;

  await client.send(new ExecuteStatementCommand({
    ...getConfig(),
    sql: `INSERT INTO user_profiles (user_id, email, updated_at)
          VALUES (:userId, :email, NOW())
          ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()`,
    parameters: [
      { name: 'userId', value: { stringValue: userId } },
      { name: 'email', value: email ? { stringValue: email } : { isNull: true } },
    ],
  }));

  return event;
};
