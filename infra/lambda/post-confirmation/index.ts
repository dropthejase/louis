import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'louis-post-confirmation' });
const client = new RDSDataClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });

function getConfig() {
  return {
    resourceArn: process.env.DB_CLUSTER_ARN!,
    secretArn: process.env.DB_SECRET_ARN!,
    database: process.env.DB_NAME!,
  };
}

const AURORA_RESUME_RE = /resuming after being auto-paused/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upsertProfile(userId: string, email: string | null, organisation: string | null): Promise<void> {
  const delays = [5000, 10000, 20000]; // 5s, 10s, 20s — total up to ~55s within 60s timeout
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await client.send(new ExecuteStatementCommand({
        ...getConfig(),
        sql: `INSERT INTO user_profiles (user_id, email, organisation, updated_at)
              VALUES (:userId, :email, :organisation, NOW())
              ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, organisation = EXCLUDED.organisation, updated_at = NOW()`,
        parameters: [
          { name: 'userId', value: { stringValue: userId } },
          { name: 'email', value: email ? { stringValue: email } : { isNull: true } },
          { name: 'organisation', value: organisation ? { stringValue: organisation } : { isNull: true } },
        ],
      }));
      return;
    } catch (err: any) {
      if (AURORA_RESUME_RE.test(err?.message ?? '') && attempt < delays.length) {
        logger.warn('Aurora resuming, retrying', { attempt, delayMs: delays[attempt] });
        await sleep(delays[attempt]);
      } else {
        throw err;
      }
    }
  }
}

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;

  const userId = event.userName;
  const email = event.request.userAttributes['email'] ?? null;
  const organisation = event.request.userAttributes['custom:organisation'] ?? null;

  logger.info('Creating user profile', { userId, email });
  await upsertProfile(userId, email, organisation);
  logger.info('User profile created', { userId });

  return event;
};
