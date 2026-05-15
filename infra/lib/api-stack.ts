/**
 * CDK stack: API Gateway + backend Lambda + AgentCore execution role + DynamoDB credits table.
 *
 * API Gateway uses a native Cognito User Pool authorizer (300s cache) — the backend Lambda
 * receives the JWT and trusts the `sub` claim as userId without re-validating the signature.
 * The AgentCore execution role is created here (not in a separate stack) because it needs
 * access to the same DynamoDB credits table; its ARN is exported for use by deploy-agent.sh.
 * Backend Lambda is ARM64; the conversion Lambda is x86_64 (LibreOffice constraint).
 */
import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as xray from 'aws-cdk-lib/aws-xray';
import { Stage } from './shared/stage';

interface ApiStackProps extends StackProps {
  stage: Stage;
  userPool: cognito.UserPool;
  docsBucket: s3.Bucket;
  sessionsBucket: s3.Bucket;
  skillsBucket: s3.Bucket;
  agentDeployBucket: s3.Bucket;
  adminBucket: s3.Bucket;
  frontendUrl: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
}

export class ApiStack extends Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiLambda: lambda.Function;
  public readonly agentCoreExecutionRoleArn: string;
  public readonly creditsTableName: string;
  public readonly creditsTableArn: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaRole = new iam.Role(this, 'ApiLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    props.docsBucket.grantReadWrite(lambdaRole);
    props.sessionsBucket.grantReadWrite(lambdaRole);
    props.skillsBucket.grantReadWrite(lambdaRole);
    props.adminBucket.grantRead(lambdaRole);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:CountTokens'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cognito-idp:AdminDeleteUser'],
      resources: [props.userPool.userPoolArn],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      resources: [props.dbClusterArn],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));

    const creditsTable = new dynamodb.Table(this, 'CreditsTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'month', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    creditsTable.grantReadWriteData(lambdaRole);

    new CfnOutput(this, 'CreditsTableName', { value: creditsTable.tableName });

    this.creditsTableName = creditsTable.tableName;
    this.creditsTableArn = creditsTable.tableArn;

    this.apiLambda = new NodejsFunction(this, 'ApiLambda', {
      entry: path.join(__dirname, '../lambda/api/lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'node22',
        nodeModules: ['pdfjs-dist'],
        externalModules: [
          '@aws-lambda-powertools/logger',
          '@aws-lambda-powertools/metrics',
          '@aws-lambda-powertools/tracer',
          '@aws-sdk/client-bedrock-runtime',
        ],
      },
      role: lambdaRole,
      timeout: cdk.Duration.seconds(29),
      memorySize: 1024,
      environment: {
        DB_CLUSTER_ARN: props.dbClusterArn,
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: props.dbName,
        DOCS_BUCKET_NAME: props.docsBucket.bucketName,
        SESSIONS_BUCKET_NAME: props.sessionsBucket.bucketName,
        SKILLS_BUCKET_NAME: props.skillsBucket.bucketName,
        ADMIN_BUCKET_NAME: props.adminBucket.bucketName,
        USER_POOL_ID: props.userPool.userPoolId,
        FRONTEND_URL: props.frontendUrl,
        CREDITS_TABLE_NAME: creditsTable.tableName,
        NODE_ENV: 'production',
        POWERTOOLS_SERVICE_NAME: 'louis-api',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, 'PowertoolsLayer',
          'arn:aws:lambda:eu-west-1:094274105915:layer:AWSLambdaPowertoolsTypeScriptV2:47'),
      ],
    });

    this.api = new apigateway.RestApi(this, 'LouisApi', {
      description: 'Louis on AWS — REST API',
      deployOptions: {
        stageName: props.stage,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [props.frontendUrl!],
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

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

    // AgentCore Runtime execution role — used by deploy-agent.sh to populate agentcore.json.
    const agentCoreRole = new iam.Role(this, 'AgentCoreExecutionRole', {
      roleName: 'MikeAgentCoreExecutionRole',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'AgentCore Runtime execution role for Mike agent',
    });

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsGroups',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
      ],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsStreams',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
      ],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsDescribe',
      effect: iam.Effect.ALLOW,
      actions: ['logs:DescribeLogGroups'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
      ],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayTracing',
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets'],
      resources: ['*'],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockModelAccess',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:CountTokens'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBCredits',
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [creditsTable.tableArn],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RdsDataApi',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      resources: [props.dbClusterArn],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerDb',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerMcp',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:louis/mcp/*`],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3DocsAccess',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${props.docsBucket.bucketArn}/*`],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3SessionsAccess',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${props.sessionsBucket.bucketArn}/*`],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3SessionsList',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.sessionsBucket.bucketArn],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3AgentDeployRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.agentDeployBucket.bucketArn}/*`],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3SkillsRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.skillsBucket.bucketArn}/*`],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3SkillsList',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.skillsBucket.bucketArn],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3PresignedUrls',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.docsBucket.bucketArn],
    }));

    agentCoreRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3AdminBucketRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.adminBucket.bucketArn}/*`],
    }));


    new CfnOutput(this, 'CreditsTableArn', { value: creditsTable.tableArn });

    this.agentCoreExecutionRoleArn = agentCoreRole.roleArn;

    // CloudWatch Transaction Search — lets X-Ray write OTEL spans to CloudWatch Logs for querying.
    // Resource policy grants xray.amazonaws.com write access; CfnTransactionSearchConfig enables indexing.
    // NOTE: if Transaction Search was previously enabled via the console, disable it there first
    // before deploying — CloudFormation will error if it already owns the resource.
    const txSearchLogPolicy = new logs.CfnResourcePolicy(this, 'TransactionSearchLogPolicy', {
      policyName: 'TransactionSearchAccess',
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'TransactionSearchXRayAccess',
          Effect: 'Allow',
          Principal: { Service: 'xray.amazonaws.com' },
          Action: 'logs:PutLogEvents',
          Resource: [
            `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans:*`,
            `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/application-signals/data:*`,
          ],
          Condition: {
            ArnLike: { 'aws:SourceArn': `arn:aws:xray:${this.region}:${this.account}:*` },
            StringEquals: { 'aws:SourceAccount': this.account },
          },
        }],
      }),
    });

    const txSearchConfig = new xray.CfnTransactionSearchConfig(this, 'TransactionSearchConfig', {
      indexingPercentage: 5,
    });
    txSearchConfig.addDependency(txSearchLogPolicy);

    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new CfnOutput(this, 'ApiLambdaArn', { value: this.apiLambda.functionArn });
    new CfnOutput(this, 'AgentCoreExecutionRoleArn', { value: agentCoreRole.roleArn });
  }
}
