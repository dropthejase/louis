import { App } from 'aws-cdk-lib';
import { getStage } from '../lib/shared/stage';

const app = new App();
const stage = getStage(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' };

// Stacks imported and instantiated in later tasks
// StorageStack, AuthStack, ApiStack, ConversionStack

app.synth();
