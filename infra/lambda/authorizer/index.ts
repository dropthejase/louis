import { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import jwksClient from 'jwks-rsa';
import jwt from 'jsonwebtoken';

const SUPABASE_JWKS_URI = process.env.SUPABASE_JWKS_URI!;
const SUPABASE_JWT_ISSUER = process.env.SUPABASE_JWT_ISSUER!;

const client = jwksClient({
  jwksUri: SUPABASE_JWKS_URI,
  cache: true,
  cacheMaxAge: 600_000, // 10 min
  rateLimit: true,
});

function getSigningKey(header: jwt.JwtHeader): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      resolve(key!.getPublicKey());
    });
  });
}

export const handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  const token = event.authorizationToken?.replace(/^Bearer\s+/i, '');
  if (!token) return deny(event.methodArn);

  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') return deny(event.methodArn);

    const signingKey = await getSigningKey(decoded.header);
    const payload = jwt.verify(token, signingKey, { issuer: SUPABASE_JWT_ISSUER }) as jwt.JwtPayload;

    const userId = payload.sub!;
    const userEmail = (payload.email as string) ?? '';

    return {
      principalId: userId,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }],
      },
      context: { userId, userEmail },
    };
  } catch {
    return deny(event.methodArn);
  }
};

function deny(resource: string): APIGatewayAuthorizerResult {
  return {
    principalId: 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: resource }],
    },
  };
}
