/**
 * CDK stack: Cognito User Pool and post-confirmation trigger.
 *
 * The User Pool uses email sign-in with optional TOTP MFA. The app client uses SRP auth
 * with no client secret so it can be used safely from the browser. A post-confirmation
 * Lambda trigger inserts a `user_profiles` row via the RDS Data API immediately after
 * a user verifies their email — this is the only place user_profiles rows are created.
 */
import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import { Stage } from './shared/stage';

interface AuthStackProps extends StackProps {
  stage: Stage;
  dbClusterArn?: string;
  dbSecretArn?: string;
  dbName?: string;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      customAttributes: {
        organisation: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // App Client — SRP auth, no client secret (browser-safe)
    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // Post Confirmation Lambda — creates user_profiles row after email verification
    const postConfirmationFn = new lambdaNodejs.NodejsFunction(this, 'PostConfirmation', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/post-confirmation/index.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        externalModules: ['@aws-sdk/*', '@aws-lambda-powertools/logger'],
      },
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, 'PowertoolsLayer',
          'arn:aws:lambda:eu-west-1:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:47'),
      ],
      timeout: Duration.seconds(60),
      memorySize: 128,
      environment: {
        DB_CLUSTER_ARN: props.dbClusterArn ?? '',
        DB_SECRET_ARN: props.dbSecretArn ?? '',
        DB_NAME: props.dbName ?? '',
      },
    });
    if (props.dbClusterArn) {
      postConfirmationFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['rds-data:ExecuteStatement'],
        resources: [props.dbClusterArn],
      }));
    }
    if (props.dbSecretArn) {
      postConfirmationFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.dbSecretArn],
      }));
    }
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmationFn);

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
