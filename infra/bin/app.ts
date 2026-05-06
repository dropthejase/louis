import { App } from 'aws-cdk-lib';
import { getStage } from '../lib/shared/stage';
import { StorageStack } from '../lib/storage-stack';
import { AuthStack } from '../lib/auth-stack';

const app = new App();
const stage = getStage(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' };

const supabaseProjectUrl = app.node.tryGetContext('supabaseProjectUrl') as string;
if (!supabaseProjectUrl) throw new Error('Pass -c supabaseProjectUrl=https://xxxx.supabase.co');

const storageStack = new StorageStack(app, 'StorageStack', { env, stage });

const authStack = new AuthStack(app, 'AuthStack', {
  env,
  stage,
  docsBucket: storageStack.docsBucket,
  supabaseProjectUrl,
});
authStack.addDependency(storageStack);

app.synth();
