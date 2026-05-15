/**
 * CDK stack: shared admin config for AI agents.
 *
 * Provisions:
 *   - adminBucket: private S3 bucket for admin-managed agent config files.
 *     AWS admin uploads files directly; no application write access.
 *     Current files:
 *       mcp.json             — MCP server config
 *       browse-allowlist.json — allowed domains for browse_web tool
 */
import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Stage } from './shared/stage';

interface AgentStackProps extends StackProps {
  stage: Stage;
}

export class AgentStack extends Stack {
  public readonly adminBucket: s3.Bucket;
  public readonly adminBucketName: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // Admin config bucket — private, no public access, no app writes.
    this.adminBucket = new s3.Bucket(this, 'AdminBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.adminBucketName = this.adminBucket.bucketName;

    new s3deploy.BucketDeployment(this, 'SeedAdminConfig', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../assets'), {
        exclude: ['**', '!mcp.json', '!browse-allowlist.json'],
      })],
      destinationBucket: this.adminBucket,
    });

    new CfnOutput(this, 'AdminBucketName', { value: this.adminBucket.bucketName });
  }
}
