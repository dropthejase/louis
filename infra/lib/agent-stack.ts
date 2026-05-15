/**
 * CDK stack: shared admin config for AI agents.
 *
 * Provisions:
 *   - adminBucket: private S3 bucket for admin-managed agent config files.
 *     AWS admin uploads files directly; no application write access.
 *     Current files:
 *       chrome-policy.json  — Chrome Enterprise policy for AgentCore Browser
 *       mcp.json            — MCP server config (future)
 *
 *   - browserCustom: AgentCore CfnBrowserCustom resource with Chrome Enterprise
 *     policy loaded from adminBucket/chrome-policy.json. The browser ARN is
 *     passed to ApiStack so the agent container can reference it via BROWSER_ARN.
 *
 *   - browserExecutionRole: IAM role assumed by bedrock-agentcore.amazonaws.com
 *     to access the adminBucket for policy reads.
 */
import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Stage } from './shared/stage';

interface AgentStackProps extends StackProps {
  stage: Stage;
}

export class AgentStack extends Stack {
  public readonly adminBucket: s3.Bucket;
  public readonly adminBucketName: string;
  public readonly browserArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // Admin config bucket — private, no public access, no app writes.
    this.adminBucket = new s3.Bucket(this, 'AdminBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Execution role assumed by AgentCore Browser to read the policy from S3.
    const browserExecutionRole = new iam.Role(this, 'BrowserExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'Execution role for AgentCore Browser, reads Chrome Enterprise policy from S3',
    });

    browserExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadAdminBucket',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${this.adminBucket.bucketArn}/*`],
    }));

    // Custom AgentCore Browser with Chrome Enterprise policy from adminBucket.
    const browser = new agentcore.CfnBrowserCustom(this, 'BrowserCustom', {
      name: 'mikeBrowser',
      executionRoleArn: browserExecutionRole.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      enterprisePolicies: [
        {
          location: {
            bucket: this.adminBucket.bucketName,
            prefix: 'chrome-policy.json',
          },
          type: 'MANAGED',
        },
      ],
    });

    this.browserArn = browser.attrBrowserArn;
    this.adminBucketName = this.adminBucket.bucketName;

    // Seed chrome-policy.json from assets/ on first deploy.
    // Admin can overwrite it directly in S3 afterwards — BucketDeployment
    // only uploads if the file doesn't exist or has changed (etag-based).
    const seedDeployment = new s3deploy.BucketDeployment(this, 'SeedAdminConfig', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../assets'), {
        exclude: ['**', '!chrome-policy.json', '!browse-allowlist.json'],
      })],
      destinationBucket: this.adminBucket,
    });

    // Browser resource must wait for the policy file to exist in S3.
    browser.node.addDependency(seedDeployment);

    new CfnOutput(this, 'AdminBucketName', { value: this.adminBucket.bucketName });
    new CfnOutput(this, 'BrowserArn', { value: this.browserArn });
  }
}
