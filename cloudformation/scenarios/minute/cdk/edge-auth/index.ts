import { Authenticator } from 'cognito-at-edge';
import type { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';

function createAuthenticator(): Authenticator {
  const region = process.env.COGNITO_REGION;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const userPoolAppId = process.env.COGNITO_USER_POOL_CLIENT_ID;
  const userPoolAppSecret = process.env.COGNITO_USER_POOL_CLIENT_SECRET;
  const userPoolDomain = process.env.COGNITO_USER_POOL_DOMAIN;

  if (!region || !userPoolId || !userPoolAppId || !userPoolAppSecret || !userPoolDomain) {
    throw new Error('Missing Cognito edge auth environment configuration');
  }

  return new Authenticator({
    region,
    userPoolId,
    userPoolAppId,
    userPoolAppSecret,
    userPoolDomain,
    cookiePath: '/',
  });
}

let authenticator: Authenticator | undefined;

export const handler = async (
  event: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> => {
  if (!authenticator) {
    authenticator = createAuthenticator();
  }
  return authenticator.handle(event);
};
