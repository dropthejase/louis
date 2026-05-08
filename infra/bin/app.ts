import { App } from 'aws-cdk-lib';
import { getStage } from '../lib/shared/stage';
import { StorageStack } from '../lib/storage-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';
import { ConversionStack } from '../lib/conversion-stack';

const app = new App();
const stage = getStage(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' };

const storageStack = new StorageStack(app, 'StorageStack', { env, stage });

const authStack = new AuthStack(app, 'AuthStack', {
  env,
  stage,
  docsBucket: storageStack.docsBucket,
});
authStack.addDependency(storageStack);

const apiStack = new ApiStack(app, 'ApiStack', {
  env,
  stage,
  userPool: authStack.userPool,
  docsBucket: storageStack.docsBucket,
  sessionsBucket: storageStack.sessionsBucket,
  supabaseSecret: authStack.supabaseSecret,
});
apiStack.addDependency(authStack);

const conversionStack = new ConversionStack(app, 'ConversionStack', {
  env,
  stage,
  docsBucketArn: storageStack.docsBucket.bucketArn,
  docsBucketName: storageStack.docsBucket.bucketName,
  supabaseSecret: authStack.supabaseSecret,
});
conversionStack.addDependency(apiStack);

app.synth();
