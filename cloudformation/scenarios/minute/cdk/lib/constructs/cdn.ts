import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { MinuteAuthMode } from '../context';
import type { CognitoEdgeAuthStack } from '../cognito-edge-auth-stack';
import { SecurityHeadersConstruct } from './security-headers';

export interface CdnConstructProps {
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly webAcl?: wafv2.CfnWebACL;
  readonly geoAllowlist?: string[];
  readonly enableSecurityHeaders?: boolean;
  readonly authMode: MinuteAuthMode;
  readonly cognitoEdgeAuth?: CognitoEdgeAuthStack;
}

export class CdnConstruct extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly domainName: string;
  /** Magic-link token; empty when authMode is cognito. */
  public readonly authToken: string;
  public readonly userPoolClientId?: string;
  public readonly cognitoSignInUrl?: string;

  constructor(scope: Construct, id: string, props: CdnConstructProps) {
    super(scope, id);

    const enableSecurityHeaders = props.enableSecurityHeaders !== false;
    const securityHeaders = enableSecurityHeaders
      ? new SecurityHeadersConstruct(this, 'SecurityHeaders')
      : undefined;

    const geoAllowlist = props.geoAllowlist ?? [];

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Minute AI - HTTPS Termination',
      webAclId: props.webAcl?.attrArn,
      geoRestriction: geoAllowlist.length > 0
        ? cloudfront.GeoRestriction.allowlist(...geoAllowlist)
        : undefined,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(props.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        responseHeadersPolicy: securityHeaders?.policy,
      },
    });

    this.domainName = this.distribution.distributionDomainName;
    const cfnDistribution = this.distribution.node.defaultChild as cloudfront.CfnDistribution;

    if (props.authMode === 'magic-link') {
      this.authToken = this.attachMagicLinkAuth(cfnDistribution);
    } else {
      this.authToken = '';
      if (!props.cognitoEdgeAuth) {
        throw new Error('Cognito auth requires cognitoEdgeAuth stack');
      }
      const { clientId, signInUrl } = this.attachCognitoAuth(
        cfnDistribution,
        props.cognitoEdgeAuth,
      );
      this.userPoolClientId = clientId;
      this.cognitoSignInUrl = signInUrl;
    }
  }

  private attachMagicLinkAuth(cfnDistribution: cloudfront.CfnDistribution): string {
    const authTokenRole = new iam.Role(this, 'AuthTokenRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const authTokenFn = new lambda.Function(this, 'AuthTokenFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      role: authTokenRole,
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
const crypto = require('crypto');
const https = require('https');
exports.handler = async (e) => {
  const rp = { Status: 'SUCCESS', PhysicalResourceId: e.LogicalResourceId, StackId: e.StackId, RequestId: e.RequestId, LogicalResourceId: e.LogicalResourceId, Data: {} };
  if (e.RequestType === 'Delete') { await send(e.ResponseURL, rp); return; }
  try {
    const token = crypto.randomBytes(16).toString('hex');
    rp.Data = { Token: token };
    await send(e.ResponseURL, rp);
  } catch (err) { rp.Status = 'FAILED'; rp.Reason = err.message; await send(e.ResponseURL, rp); }
};
function send(u, d) { return new Promise((ok, fail) => { const b = JSON.stringify(d); const o = new URL(u); const opts = { hostname: o.hostname, port: 443, path: o.pathname + o.search, method: 'PUT', headers: { 'Content-Type': '', 'Content-Length': b.length } }; const req = https.request(opts, ok); req.on('error', fail); req.write(b); req.end(); }); }
      `),
    });

    const authTokenCR = new cdk.CustomResource(this, 'AuthTokenCR', {
      serviceToken: authTokenFn.functionArn,
    });
    authTokenCR.node.addDependency(authTokenRole);

    const authToken = authTokenCR.getAttString('Token');

    const stackOutputsUrl =
      `https://${cdk.Aws.REGION}.console.aws.amazon.com/cloudformation/home` +
      `?region=${cdk.Aws.REGION}#/stacks/outputs` +
      `?filteringText=&filteringStatus=active&viewNested=true&stackId=${cdk.Aws.STACK_NAME}`;

    const functionSrc = `function handler(event) {
  var request = event.request;
  var TOKEN = '\${Token}';
  var COOKIE_NAME = 'ndx-minute-auth';

  if (request.querystring.key && request.querystring.key.value === TOKEN) {
    var qs = '';
    for (var k in request.querystring) {
      if (k === 'key') continue;
      var v = request.querystring[k];
      qs += (qs ? '&' : '') + k + (v.value ? '=' + v.value : '');
    }
    var location = request.uri + (qs ? '?' + qs : '');
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: { location: { value: location } },
      cookies: {
        'ndx-minute-auth': {
          value: TOKEN,
          attributes: 'Max-Age=604800; Secure; HttpOnly; SameSite=Lax; Path=/'
        }
      }
    };
  }

  if (request.cookies[COOKIE_NAME] && request.cookies[COOKIE_NAME].value === TOKEN) {
    return request;
  }

  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: { 'content-type': { value: 'text/html; charset=utf-8' } },
    body: '<!doctype html><meta charset=utf-8><title>Access required</title>'
        + '<style>body{font-family:system-ui,Arial,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#0b0c0c}h1{font-size:1.5rem}code{background:#f3f2f1;padding:2px 6px;border-radius:3px}a{color:#1d70b8}</style>'
        + '<h1>NDX:Try Minute &mdash; session link required</h1>'
        + '<p>To open this app, use the <code>MinuteLoginUrl</code> value from the <strong>Outputs</strong> tab of your CloudFormation stack.</p>'
        + '<p><a href="\${StackOutputsUrl}">Open the CloudFormation Outputs tab &rarr;</a></p>'
  };
}`;

    const cfnFunction = new cloudfront.CfnFunction(this, 'AuthFunction', {
      name: `NdxMinute-Auth-${cdk.Aws.ACCOUNT_ID}`,
      autoPublish: true,
      functionConfig: {
        comment: 'Magic-link + cookie auth for Minute AI',
        runtime: 'cloudfront-js-2.0',
      },
      functionCode: cdk.Fn.sub(functionSrc, {
        Token: authToken,
        StackName: cdk.Aws.STACK_NAME,
        StackOutputsUrl: stackOutputsUrl,
      }),
    });

    cfnDistribution.addPropertyOverride(
      'DistributionConfig.DefaultCacheBehavior.FunctionAssociations',
      [{
        EventType: 'viewer-request',
        FunctionARN: cfnFunction.attrFunctionArn,
      }],
    );

    return authToken;
  }

  private attachCognitoAuth(
    cfnDistribution: cloudfront.CfnDistribution,
    cognitoEdgeAuth: CognitoEdgeAuthStack,
  ): { clientId: string; signInUrl: string } {
    const cognitoAuth = cognitoEdgeAuth.cognitoAuth;
    const callbackUrl = cdk.Fn.join('', ['https://', this.domainName, '/parseauth']);
    const userPoolClient = cognitoAuth.userPoolClient;

    this.updateOAuthCallbacks(
      cognitoAuth.userPool.userPoolArn,
      cognitoAuth.userPool.userPoolId,
      userPoolClient.ref,
      callbackUrl,
      cdk.Fn.join('', ['https://', this.domainName, '/']),
    );

    cfnDistribution.node.addDependency(cognitoEdgeAuth.edgeVersion);

    cfnDistribution.addPropertyOverride(
      'DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations',
      [{
        EventType: 'viewer-request',
        LambdaFunctionARN: cognitoEdgeAuth.edgeVersion.functionArn,
        IncludeBody: false,
      }],
    );

    const signInUrl = cdk.Fn.join('', [
      'https://',
      cognitoAuth.userPoolDomainHostname,
      '/login?client_id=',
      userPoolClient.ref,
      '&response_type=code&scope=openid+email+profile&redirect_uri=',
      callbackUrl,
    ]);

    return {
      clientId: userPoolClient.ref,
      signInUrl,
    };
  }

  private updateOAuthCallbacks(
    userPoolArn: string,
    userPoolId: string,
    clientId: string,
    callbackUrl: string,
    logoutUrl: string,
  ): void {
    const updateOAuthCallbacksCode = `const{CognitoIdentityProviderClient,UpdateUserPoolClientCommand}=require("@aws-sdk/client-cognito-identity-provider");const r=require("https");exports.handler=async(e)=>{const rp={Status:"SUCCESS",PhysicalResourceId:e.PhysicalResourceId||e.LogicalResourceId,StackId:e.StackId,RequestId:e.RequestId,LogicalResourceId:e.LogicalResourceId,Data:{}};if(e.RequestType==="Delete"){await send(e.ResponseURL,rp);return}try{const p=e.ResourceProperties;const cog=new CognitoIdentityProviderClient({region:p.CognitoRegion});await cog.send(new UpdateUserPoolClientCommand({UserPoolId:p.UserPoolId,ClientId:p.ClientId,CallbackURLs:[p.CallbackUrl],LogoutURLs:[p.LogoutUrl]}));await send(e.ResponseURL,rp)}catch(err){rp.Status="FAILED";rp.Reason=err.message;await send(e.ResponseURL,rp)}};function send(u,d){return new Promise((ok,fail)=>{const b=JSON.stringify(d);const o=new URL(u);const opts={hostname:o.hostname,port:443,path:o.pathname+o.search,method:"PUT",headers:{"Content-Type":"","Content-Length":b.length}};const req=r.request(opts,ok);req.on("error",fail);req.write(b);req.end()})}`;

    const updateRole = new iam.Role(this, 'UpdateOAuthCallbacksRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    updateRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:UpdateUserPoolClient'],
        resources: [userPoolArn],
      }),
    );

    const updateFn = new lambda.Function(this, 'UpdateOAuthCallbacksFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      role: updateRole,
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(updateOAuthCallbacksCode),
    });

    const updateCr = new cdk.CustomResource(this, 'UpdateOAuthCallbacksCr', {
      serviceToken: updateFn.functionArn,
      properties: {
        CognitoRegion: 'us-east-1',
        UserPoolId: userPoolId,
        ClientId: clientId,
        CallbackUrl: callbackUrl,
        LogoutUrl: logoutUrl,
      },
    });
    updateCr.node.addDependency(updateRole);
  }
}
