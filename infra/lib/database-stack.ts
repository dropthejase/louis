import { Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
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

    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_3,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      defaultDatabaseName: this.databaseName,
      enableDataApi: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.clusterArn = cluster.clusterArn;
    this.secretArn = cluster.secret!.secretArn;

    new CfnOutput(this, 'ClusterArn', { value: this.clusterArn });
    new CfnOutput(this, 'SecretArn', { value: this.secretArn });
    new CfnOutput(this, 'DatabaseName', { value: this.databaseName });
  }
}
