import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
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
  supabaseProjectUrl: string; // e.g. https://xxxx.supabase.co
}

export class AuthStack extends Stack {
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;
  public readonly authorizerFn: lambda.Function;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const jwksUri = `${props.supabaseProjectUrl}/auth/v1/.well-known/jwks.json`;
    const issuer = `${props.supabaseProjectUrl}/auth/v1`;

    // Lambda authorizer — NodejsFunction bundles at synth time via esbuild (no pre-build needed)
    this.authorizerFn = new lambdaNodejs.NodejsFunction(this, 'JwtAuthorizer', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/authorizer/index.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        SUPABASE_JWKS_URI: jwksUri,
        SUPABASE_JWT_ISSUER: issuer,
      },
      timeout: Duration.seconds(10),
      memorySize: 256,
    });

    // Cognito Identity Pool — OIDC-federated from Supabase
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      openIdConnectProviderArns: [
        // IAM OIDC provider ARN for Supabase — created separately (see scripts/create-oidc-provider.sh)
        `arn:aws:iam::${this.account}:oidc-provider/${props.supabaseProjectUrl.replace('https://', '')}/auth/v1`,
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
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    // Per-user S3 prefix policy — users can only access their own prefix
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

    // Attach role to identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: { authenticated: this.authenticatedRole.roleArn },
    });

    new CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref });
    new CfnOutput(this, 'AuthorizerFunctionArn', { value: this.authorizerFn.functionArn });
    new CfnOutput(this, 'AuthenticatedRoleArn', { value: this.authenticatedRole.roleArn });
  }
}
