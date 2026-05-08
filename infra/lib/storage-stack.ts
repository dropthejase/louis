import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Stage } from './shared/stage';
// EventBridgeNotifications enabled on docsBucket so ConversionStack can subscribe
// via EventBridge rules instead of direct S3 notifications (avoids imported-bucket issues).

interface StorageStackProps extends StackProps {
  stage: Stage;
}

export class StorageStack extends Stack {
  public readonly docsBucket: s3.Bucket;
  public readonly sessionsBucket: s3.Bucket;
  public readonly frontendBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // Documents bucket — private, per-user prefix enforced via IAM in AuthStack.
    // CORS is set after the CloudFront distribution is created so we can lock
    // allowedOrigins to the CF domain rather than '*'.
    this.docsBucket = new s3.Bucket(this, 'DocsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      eventBridgeEnabled: true,
    });

    // Sessions bucket — private, stores Strands agent conversation snapshots
    this.sessionsBucket = new s3.Bucket(this, 'SessionsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Frontend bucket — private, served only via CloudFront OAC
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront OAC for frontend bucket
    const oac = new cloudfront.S3OriginAccessControl(this, 'FrontendOAC', {
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    // CloudFront distribution — frontend only
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.frontendBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        // SPA fallback — all 404s serve index.html for client-side routing
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // Set CORS on docsBucket using the CF escape hatch so allowedOrigins can
    // reference the distribution domain — a CloudFormation token resolved at
    // deploy time. Both resources live in this stack so CDK handles ordering.
    const cfnDocsBucket = this.docsBucket.node.defaultChild as s3.CfnBucket;
    cfnDocsBucket.corsConfiguration = {
      corsRules: [
        {
          allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
          allowedOrigins: [`https://${this.distribution.distributionDomainName}`],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    };

    new CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });
    new CfnOutput(this, 'SessionsBucketName', { value: this.sessionsBucket.bucketName });
    new CfnOutput(this, 'FrontendBucketName', { value: this.frontendBucket.bucketName });
    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
