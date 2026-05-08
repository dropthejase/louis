import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Stage } from './shared/stage';

interface AuthStackProps extends StackProps {
  stage: Stage;
  docsBucket: s3.Bucket;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;
  public readonly supabaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Supabase credentials secret — used by post-confirmation and post-deletion Lambdas
    this.supabaseSecret = new secretsmanager.Secret(this, 'SupabaseCredentials', {
      description: 'Supabase URL and service role key',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ url: 'REPLACE_ME', serviceRoleKey: 'REPLACE_ME' }),
        generateStringKey: '_unused',
      },
    });

    // Pre-Token Generation v2 Lambda — injects role: "authenticated" into id token
    const preTokenGenFn = new lambdaNodejs.NodejsFunction(this, 'PreTokenGen', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/pre-token-gen/index.ts'),
      handler: 'handler',
      bundling: { minify: true, externalModules: ['@aws-sdk/*'] },
      timeout: Duration.seconds(5),
      memorySize: 128,
    });

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `louis-${props.stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true, // TOTP only
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      lambdaTriggers: {
        preTokenGeneration: preTokenGenFn,
      },
    });

    // Upgrade Pre-Token Generation trigger to V2_0 via CFN escape hatch
    // (CDK high-level API only exposes V1; V2 is required for claimsAndScopeOverrideDetails)
    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig', {
      LambdaArn: preTokenGenFn.functionArn,
      LambdaVersion: 'V2_0',
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
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/post-confirmation/index.ts'),
      handler: 'handler',
      bundling: { minify: true, externalModules: ['@aws-sdk/*'] },
      timeout: Duration.seconds(10),
      memorySize: 128,
      environment: { SUPABASE_SECRET_ARN: this.supabaseSecret.secretArn },
    });
    this.supabaseSecret.grantRead(postConfirmationFn);
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmationFn);

    // Post Deletion Lambda — deletes user_profiles row on Cognito user deletion
    // Cognito has no native delete trigger; invoked via EventBridge + CloudTrail
    const postDeletionFn = new lambdaNodejs.NodejsFunction(this, 'PostDeletion', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/post-deletion/index.ts'),
      handler: 'handler',
      bundling: { minify: true, externalModules: ['@aws-sdk/*'] },
      timeout: Duration.seconds(10),
      memorySize: 128,
      environment: { SUPABASE_SECRET_ARN: this.supabaseSecret.secretArn },
    });
    this.supabaseSecret.grantRead(postDeletionFn);

    // EventBridge rule: fire postDeletionFn on Cognito DeleteUser / AdminDeleteUser via CloudTrail
    new events.Rule(this, 'CognitoUserDeleteRule', {
      eventPattern: {
        source: ['aws.cognito-idp'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['cognito-idp.amazonaws.com'],
          eventName: ['DeleteUser', 'AdminDeleteUser'],
          requestParameters: {
            userPoolId: [this.userPool.userPoolId],
          },
        },
      },
      targets: [new targets.LambdaFunction(postDeletionFn)],
    });

    // Cognito Identity Pool — native User Pool federation
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
          serverSideTokenCheck: false,
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

    // Per-user S3 prefix policy
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        `${props.docsBucket.bucketArn}/documents/\${cognito-identity.amazonaws.com:sub}/*`,
        `${props.docsBucket.bucketArn}/generated/\${cognito-identity.amazonaws.com:sub}/*`,
      ],
    }));

    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.docsBucket.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['documents/${cognito-identity.amazonaws.com:sub}/*'] },
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
