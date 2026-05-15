/**
 * CDK stack: Cognito User Pool, Identity Pool, and post-confirmation trigger.
 *
 * The User Pool uses email sign-in (no MFA). The app client uses SRP auth
 * with no client secret so it can be used safely from the browser. A post-confirmation
 * Lambda trigger inserts a `user_profiles` row via the RDS Data API immediately after
 * a user verifies their email — this is the only place user_profiles rows are created.
 * The Identity Pool issues short-lived IAM credentials scoped to the user's own S3 prefix
 * (`documents/{sub}/` and `generated/{sub}/`) for direct-upload from the frontend.
 */
import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { Stage } from './shared/stage';

interface AuthStackProps extends StackProps {
  stage: Stage;
  docsBucket: s3.Bucket;
  dbClusterArn?: string;
  dbSecretArn?: string;
  dbName?: string;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;

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

    // Cognito Identity Pool — native User Pool federation
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
          serverSideTokenCheck: true,
        },
      ],
    });

    // IAM role for authenticated Identity Pool users
    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': this.identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // Per-user S3 prefix policy — ${cognito-identity.amazonaws.com:sub} resolves to the
    // Cognito Identity ID at runtime (the identity pool identity, not the user pool sub).
    // Uploads no longer use Identity Pool credentials (presigned URLs via backend instead),
    // but reads/deletes from the frontend still use these credentials.
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:DeleteObject'],
      resources: [
        `${props.docsBucket.bucketArn}/documents/\${cognito-identity.amazonaws.com:sub}/*`,
        `${props.docsBucket.bucketArn}/generated/\${cognito-identity.amazonaws.com:sub}/*`,
        `${props.docsBucket.bucketArn}/converted-pdfs/\${cognito-identity.amazonaws.com:sub}/*`,
      ],
    }));

    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.docsBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': [
            'documents/${cognito-identity.amazonaws.com:sub}/*',
            'generated/${cognito-identity.amazonaws.com:sub}/*',
            'converted-pdfs/${cognito-identity.amazonaws.com:sub}/*',
          ],
        },
      },
    }));

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: { authenticated: this.authenticatedRole.roleArn },
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref });
    new CfnOutput(this, 'AuthenticatedRoleArn', { value: this.authenticatedRole.roleArn });
  }
}
