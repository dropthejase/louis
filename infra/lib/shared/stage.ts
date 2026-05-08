/**
 * Shared stage type and CDK context helper.
 *
 * Stage is passed to every stack via CDK context (`-c stage=dev|prod`).
 * `getStage` throws at synth time if the value is missing or invalid — this prevents
 * accidentally deploying with an undefined stage and using the wrong resource names.
 */
import { App } from 'aws-cdk-lib';

export type Stage = 'dev' | 'prod';

export function getStage(app: App): Stage {
  const stage = app.node.tryGetContext('stage') as string | undefined;
  if (!stage || (stage !== 'dev' && stage !== 'prod')) {
    throw new Error('Pass -c stage=dev or -c stage=prod');
  }
  return stage;
}
