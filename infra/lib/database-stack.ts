/**
 * CDK stack: Aurora Serverless v2 Postgres cluster with Data API enabled.
 *
 * All application code accesses the database exclusively through the RDS Data API
 * (never direct TCP). `enableDataApi: true` is required for this. The cluster runs
 * in isolated subnets (no NAT gateway) — Data API traffic routes through the VPC
 * endpoint created automatically by Aurora when Data API is enabled.
 * Capacity is set to 0–1 ACUs so the cluster scales to zero when idle.
 */
import { Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Stage } from './shared/stage';

interface DatabaseStackProps extends StackProps {
  stage: Stage;
}

export class DatabaseStack extends Stack {
  public readonly clusterArn: string;
  public readonly secretArn: string;
  public readonly databaseName: string;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.databaseName = 'louis';

    const vpc = new ec2.Vpc(this, 'AuroraVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_9,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      defaultDatabaseName: this.databaseName,
      enableDataApi: true,
      removalPolicy: RemovalPolicy.DESTROY,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    this.clusterArn = cluster.clusterArn;
    this.secretArn = cluster.secret!.secretArn;

    new CfnOutput(this, 'ClusterArn', { value: this.clusterArn });
    new CfnOutput(this, 'SecretArn', { value: this.secretArn });
    new CfnOutput(this, 'DatabaseName', { value: this.databaseName });
  }
}
