/**
 * CDK stack: DOCX→PDF conversion Lambda + EventBridge rules.
 *
 * The conversion Lambda runs as an x86_64 Docker image (LibreOffice is not available for
 * ARM64 in Lambda container images). It is triggered by EventBridge Object Created events
 * on `.docx` and `.doc` files under the `documents/` prefix; EventBridge is used rather
 * than direct S3 notifications to avoid the CDK cross-stack imported-bucket limitation.
 * Two separate EventBridge rules handle `.docx` and `.doc` suffixes respectively because
 * EventBridge content filtering does not support OR within a single suffix filter.
 * Timeout is 5 minutes to accommodate large or complex documents.
 */
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Stage } from './shared/stage';

interface ConversionStackProps extends StackProps {
  stage: Stage;
  docsBucketArn: string;
  docsBucketName: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
}

export class ConversionStack extends Stack {
  public readonly conversionLambda: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: ConversionStackProps) {
    super(scope, id, props);

    const lambdaRole = new iam.Role(this, 'ConversionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant read/write on the docs bucket by ARN — no cross-stack construct reference needed.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${props.docsBucketArn}/*`],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.docsBucketArn],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rds-data:ExecuteStatement'],
      resources: [props.dbClusterArn],
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    }));

    this.conversionLambda = new lambda.DockerImageFunction(this, 'ConversionLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../lambda/conversion')),
      role: lambdaRole,
      timeout: Duration.minutes(5),
      memorySize: 2048,
      environment: {
        DOCS_BUCKET_NAME: props.docsBucketName,
        POWERTOOLS_SERVICE_NAME: 'mike-conversion',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        DB_CLUSTER_ARN: props.dbClusterArn,
        DB_SECRET_ARN: props.dbSecretArn,
        DB_NAME: props.dbName,
      },
    });

    // Single EventBridge rule: trigger on any object created under documents/ prefix.
    // The Lambda handler routes internally by extension (.pdf passthrough, .docx/.doc convert).
    // Scoping to documents/ prefix prevents converted-pdfs/ writes from re-triggering the Lambda.
    // Requires eventBridgeEnabled: true on the S3 bucket (set in StorageStack).
    const documentsRule = new events.Rule(this, 'DocumentsUploadRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.docsBucketName] },
          object: { key: [{ prefix: 'documents/' }] },
        },
      },
    });
    documentsRule.addTarget(new targets.LambdaFunction(this.conversionLambda));

    new CfnOutput(this, 'ConversionLambdaArn', { value: this.conversionLambda.functionArn });
  }
}
