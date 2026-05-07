import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Stage } from './shared/stage';

interface ApiStackProps extends StackProps {
  stage: Stage;
  userPool: cognito.UserPool;
  docsBucket: s3.Bucket;
  sessionsBucket: s3.Bucket;
  frontendUrl?: string;
}

export class ApiStack extends Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiLambda: lambda.Function;
  public readonly supabaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.supabaseSecret = new secretsmanager.Secret(this, 'SupabaseCredentials', {
      description: 'Supabase URL and service role key for Louis API Lambda',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ url: 'REPLACE_ME', serviceRoleKey: 'REPLACE_ME' }),
        generateStringKey: '_unused',
      },
    });

    const lambdaRole = new iam.Role(this, 'ApiLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    this.supabaseSecret.grantRead(lambdaRole);
    props.docsBucket.grantReadWrite(lambdaRole);
    props.sessionsBucket.grantRead(lambdaRole);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:eu-west-1::foundation-model/eu.anthropic.claude-opus-4-7-20251101-v1:0',
        'arn:aws:bedrock:eu-west-1::foundation-model/eu.anthropic.claude-sonnet-4-6-20250922-v1:0',
        'arn:aws:bedrock:eu-west-1::foundation-model/eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));

    this.apiLambda = new lambda.DockerImageFunction(this, 'ApiLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../backend'), {
        file: 'Dockerfile.lambda',
      }),
      architecture: lambda.Architecture.ARM_64,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(29),
      memorySize: 1024,
      environment: {
        SUPABASE_SECRET_ARN: this.supabaseSecret.secretArn,
        DOCS_BUCKET_NAME: props.docsBucket.bucketName,
        SESSIONS_BUCKET_NAME: props.sessionsBucket.bucketName,
        FRONTEND_URL: props.frontendUrl ?? '*',
        NODE_ENV: 'production',
        POWERTOOLS_SERVICE_NAME: 'louis-api',
        POWERTOOLS_LOG_LEVEL: props.stage === 'dev' ? 'DEBUG' : 'INFO',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    this.api = new apigateway.RestApi(this, 'LouisApi', {
      description: 'Louis on AWS — REST API',
      deployOptions: {
        stageName: props.stage,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: props.stage === 'dev',
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Native Cognito User Pool authorizer — no Lambda, no cold start
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
      resultsCacheTtl: Duration.seconds(300),
      identitySource: 'method.request.header.Authorization',
    });

    const proxyResource = this.api.root.addResource('{proxy+}');
    proxyResource.addMethod('ANY', new apigateway.LambdaIntegration(this.apiLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    this.api.root.addMethod('ANY', new apigateway.LambdaIntegration(this.apiLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new CfnOutput(this, 'ApiLambdaArn', { value: this.apiLambda.functionArn });
    new CfnOutput(this, 'SupabaseSecretArn', { value: this.supabaseSecret.secretArn });
  }
}
