import { App } from 'aws-cdk-lib';
import { getStage } from '../lib/shared/stage';
import { StorageStack } from '../lib/storage-stack';

const app = new App();
const stage = getStage(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' };

const storageStack = new StorageStack(app, 'StorageStack', { env, stage });

app.synth();
