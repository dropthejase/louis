import { App } from 'aws-cdk-lib';
import { getStage } from '../lib/shared/stage';
import { StorageStack } from '../lib/storage-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';
import { AgentStack } from '../lib/agent-stack';
import { ConversionStack } from '../lib/conversion-stack';
import { DatabaseStack } from '../lib/database-stack';

const app = new App();
const stage = getStage(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' };

const storageStack = new StorageStack(app, 'StorageStack', { env, stage });

const agentStack = new AgentStack(app, 'AgentStack', { env, stage });

const databaseStack = new DatabaseStack(app, 'DatabaseStack', { env, stage });

const authStack = new AuthStack(app, 'AuthStack', {
  env,
  stage,
  dbClusterArn: databaseStack.clusterArn,
  dbSecretArn: databaseStack.secretArn,
  dbName: databaseStack.databaseName,
});
authStack.addDependency(databaseStack);

const apiStack = new ApiStack(app, 'ApiStack', {
  env,
  stage,
  userPool: authStack.userPool,
  docsBucket: storageStack.docsBucket,
  sessionsBucket: storageStack.sessionsBucket,
  skillsBucket: storageStack.skillsBucket,
  agentDeployBucket: storageStack.agentDeployBucket,
  frontendUrl: `https://${storageStack.distribution.distributionDomainName}`,
  dbClusterArn: databaseStack.clusterArn,
  dbSecretArn: databaseStack.secretArn,
  dbName: databaseStack.databaseName,
  adminBucket: agentStack.adminBucket,
});
apiStack.addDependency(authStack);
apiStack.addDependency(databaseStack);
apiStack.addDependency(agentStack);

const conversionStack = new ConversionStack(app, 'ConversionStack', {
  env,
  stage,
  docsBucketArn: storageStack.docsBucket.bucketArn,
  docsBucketName: storageStack.docsBucket.bucketName,
  dbClusterArn: databaseStack.clusterArn,
  dbSecretArn: databaseStack.secretArn,
  dbName: databaseStack.databaseName,
});
conversionStack.addDependency(apiStack);
conversionStack.addDependency(databaseStack);

app.synth();
