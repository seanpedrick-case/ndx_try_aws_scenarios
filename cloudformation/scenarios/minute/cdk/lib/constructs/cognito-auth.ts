import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

const ADMIN_USERNAME = 'admin';
const ADMIN_EMAIL = 'admin@ndx-try.local';

const SET_PASSWORD_LAMBDA_CODE = `const{CognitoIdentityProviderClient,AdminSetUserPasswordCommand}=require("@aws-sdk/client-cognito-identity-provider");const c=require("crypto");const r=require("https");exports.handler=async(e)=>{const rp={Status:"SUCCESS",PhysicalResourceId:e.LogicalResourceId,StackId:e.StackId,RequestId:e.RequestId,LogicalResourceId:e.LogicalResourceId,Data:{}};if(e.RequestType==="Delete"){await send(e.ResponseURL,rp);return}try{const pw=c.randomBytes(12).toString("base64").slice(0,16).replace(/\\+/g,"!")+"A1a!";const cog=new CognitoIdentityProviderClient();await cog.send(new AdminSetUserPasswordCommand({UserPoolId:e.ResourceProperties.UserPoolId,Username:e.ResourceProperties.Username,Password:pw,Permanent:true}));rp.Data={Password:pw};await send(e.ResponseURL,rp)}catch(err){rp.Status="FAILED";rp.Reason=err.message;await send(e.ResponseURL,rp)}};function send(u,d){return new Promise((ok,fail)=>{const b=JSON.stringify(d);const o=new URL(u);const opts={hostname:o.hostname,port:443,path:o.pathname+o.search,method:"PUT",headers:{"Content-Type":"","Content-Length":b.length}};const req=r.request(opts,ok);req.on("error",fail);req.write(b);req.end()})}`;

export class CognitoAuthConstruct extends Construct {
  public readonly userPool: cognito.IUserPool;
  public readonly userPoolClient: cognito.CfnUserPoolClient;
  public readonly userPoolDomain: string;
  public readonly userPoolDomainHostname: string;
  public readonly adminUsername: string = ADMIN_USERNAME;
  public readonly adminPassword: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `NdxMinute-${cdk.Aws.ACCOUNT_ID}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: {
        domainPrefix: `ndx-minute-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    this.userPoolDomainHostname = domain.domainName;
    this.userPoolDomain = `https://${domain.domainName}`;

    // Placeholder callbacks are updated after CloudFront domain is known (see CdnConstruct).
    this.userPoolClient = new cognito.CfnUserPoolClient(this, 'CloudFrontClient', {
      userPoolId: this.userPool.userPoolId,
      clientName: 'ndx-minute-cloudfront',
      generateSecret: true,
      explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      allowedOAuthFlows: ['code'],
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      callbackUrLs: ['https://cloudfront-placeholder.invalid/parseauth'],
      logoutUrLs: ['https://cloudfront-placeholder.invalid/'],
      supportedIdentityProviders: ['COGNITO'],
      preventUserExistenceErrors: 'ENABLED',
    });

    new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: this.userPool.userPoolId,
      username: ADMIN_USERNAME,
      userAttributes: [
        { name: 'email', value: ADMIN_EMAIL },
        { name: 'email_verified', value: 'true' },
      ],
    });

    const setPasswordRole = new iam.Role(this, 'SetPasswordRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    setPasswordRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminSetUserPassword'],
        resources: [this.userPool.userPoolArn],
      }),
    );

    const setPasswordFn = new lambda.Function(this, 'SetPasswordFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      role: setPasswordRole,
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(SET_PASSWORD_LAMBDA_CODE),
    });

    const setPasswordCr = new cdk.CustomResource(this, 'SetPasswordCr', {
      serviceToken: setPasswordFn.functionArn,
      properties: {
        UserPoolId: this.userPool.userPoolId,
        Username: ADMIN_USERNAME,
      },
    });
    setPasswordCr.node.addDependency(setPasswordRole);

    this.adminPassword = setPasswordCr.getAttString('Password');
  }
}
