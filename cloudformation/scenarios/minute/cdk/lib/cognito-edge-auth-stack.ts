import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import { Construct } from 'constructs';
import { CognitoAuthConstruct } from './constructs/cognito-auth';

/**
 * Cognito user pool + Lambda@Edge for CloudFront auth. Deployed to us-east-1
 * (Lambda@Edge requirement). The main Minute stack references this stack only
 * (edge version ARN, pool/client IDs) to avoid bidirectional cross-stack cycles.
 */
export class CognitoEdgeAuthStack extends cdk.Stack {
  public readonly cognitoAuth: CognitoAuthConstruct;
  public readonly edgeVersion: lambda.IVersion;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.cognitoAuth = new CognitoAuthConstruct(this, 'CognitoAuth');

    const edgeFn = new NodejsFunction(this, 'CognitoAtEdge', {
      entry: path.join(process.cwd(), 'edge-auth', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
      },
      environment: {
        COGNITO_REGION: cdk.Aws.REGION,
        COGNITO_USER_POOL_ID: this.cognitoAuth.userPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: this.cognitoAuth.userPoolClient.ref,
        COGNITO_USER_POOL_CLIENT_SECRET: this.cognitoAuth.userPoolClient.attrClientSecret,
        COGNITO_USER_POOL_DOMAIN: this.cognitoAuth.userPoolDomainHostname,
      },
    });

    edgeFn.node.addDependency(this.cognitoAuth.userPoolClient);
    this.edgeVersion = edgeFn.currentVersion;
  }
}
