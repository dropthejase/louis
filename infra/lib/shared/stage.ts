import { App } from 'aws-cdk-lib';

export type Stage = 'dev' | 'prod';

export function getStage(app: App): Stage {
  const stage = app.node.tryGetContext('stage') as string | undefined;
  if (!stage || (stage !== 'dev' && stage !== 'prod')) {
    throw new Error('Pass -c stage=dev or -c stage=prod');
  }
  return stage;
}
