import { App } from 'aws-cdk-lib';
import { getStage } from '../lib/shared/stage';
import { StorageStack } from '../lib/storage-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';
import { ConversionStack } from '../lib/conversion-stack';
import { DatabaseStack } from '../lib/database-stack';

const app = new App();
const stage = getStage(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' };

const storageStack = new StorageStack(app, 'StorageStack', { env, stage });

const databaseStack = new DatabaseStack(app, 'DatabaseStack', { env, stage });

const authStack = new AuthStack(app, 'AuthStack', {
  env,
  stage,
  docsBucket: storageStack.docsBucket,
  dbClusterArn: databaseStack.clusterArn,
  dbSecretArn: databaseStack.secretArn,
  dbName: databaseStack.databaseName,
});
authStack.addDependency(storageStack);
authStack.addDependency(databaseStack);

const apiStack = new ApiStack(app, 'ApiStack', {
  env,
  stage,
  userPool: authStack.userPool,
  docsBucket: storageStack.docsBucket,
  sessionsBucket: storageStack.sessionsBucket,
  frontendUrl: `https://${storageStack.distribution.distributionDomainName}`,
  dbClusterArn: databaseStack.clusterArn,
  dbSecretArn: databaseStack.secretArn,
  dbName: databaseStack.databaseName,
});
apiStack.addDependency(authStack);
apiStack.addDependency(databaseStack);

const conversionStack = new ConversionStack(app, 'ConversionStack', {
  env,
  stage,
  docsBucketArn: storageStack.docsBucket.bucketArn,
  docsBucketName: storageStack.docsBucket.bucketName,
});
conversionStack.addDependency(apiStack);

app.synth();
