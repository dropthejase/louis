// backend/src/lambda.ts
//
// Lambda handler — wraps the Express app with serverless-http.
// Powertools middleware (logger, tracer, metrics) is applied via middy.
//
// Environment variables required at runtime:
//   POWERTOOLS_SERVICE_NAME  — defaults to "mike-api"
//   POWERTOOLS_LOG_LEVEL     — defaults to "INFO"
//   AWS_REGION               — set automatically by Lambda runtime
//   DB_CLUSTER_ARN           — Aurora cluster ARN
//   DB_SECRET_ARN            — RDS-managed credentials secret ARN
//   DB_NAME                  — database name
//   DOCS_BUCKET_NAME         — documents bucket
//   SESSIONS_BUCKET_NAME     — sessions bucket
//   USER_POOL_ID             — Cognito User Pool ID
//   FRONTEND_URL             — CloudFront domain for CORS

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import serverless from "serverless-http";
import middy from "@middy/core";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";

import { app } from "./app";
import { loadSecrets } from "./lib/secrets";

const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "mike-api" });
const tracer = new Tracer({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "mike-api" });
const metrics = new Metrics({ namespace: "MikeApi", serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? "mike-api" });

const serverlessHandler = serverless(app);

async function lambdaHandler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  await loadSecrets();

  metrics.addMetric("InvocationCount", MetricUnit.Count, 1);

  const result = await serverlessHandler(event, context);
  return result as APIGatewayProxyResult;
}

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { clearState: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
