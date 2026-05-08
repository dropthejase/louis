import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as path from 'path';
import { Stage } from './shared/stage';

interface ConversionStackProps extends StackProps {
  stage: Stage;
  // Pass bucket ARN + name as strings to avoid cross-stack construct references
  // that would create a dependency cycle (S3 event notifications reference Lambda ARN,
  // which would make StorageStack depend on ConversionStack and vice versa).
  docsBucketArn: string;
  docsBucketName: string;
}

export class ConversionStack extends Stack {
  public readonly conversionLambda: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: ConversionStackProps) {
    super(scope, id, props);

    // Import bucket by ARN to avoid cross-stack construct dependency cycle
    const docsBucket = s3.Bucket.fromBucketAttributes(this, 'ImportedDocsBucket', {
      bucketArn: props.docsBucketArn,
      bucketName: props.docsBucketName,
    });

    const lambdaRole = new iam.Role(this, 'ConversionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    docsBucket.grantReadWrite(lambdaRole);

    this.conversionLambda = new lambda.DockerImageFunction(this, 'ConversionLambda', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../conversion')),
      role: lambdaRole,
      timeout: Duration.minutes(5), // LibreOffice conversion can be slow for large docs
      memorySize: 2048,
      environment: {
        DOCS_BUCKET_NAME: props.docsBucketName,
        POWERTOOLS_SERVICE_NAME: 'mike-conversion',
        POWERTOOLS_LOG_LEVEL: props.stage === 'dev' ? 'DEBUG' : 'INFO',
      },
    });

    // Trigger on .docx and .doc uploads to documents/ prefix
    docsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.conversionLambda),
      { prefix: 'documents/', suffix: '.docx' }
    );

    docsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.conversionLambda),
      { prefix: 'documents/', suffix: '.doc' }
    );

    new CfnOutput(this, 'ConversionLambdaArn', { value: this.conversionLambda.functionArn });
  }
}
