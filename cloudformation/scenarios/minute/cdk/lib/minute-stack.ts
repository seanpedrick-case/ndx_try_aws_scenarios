import * as cdk from 'aws-cdk-lib';
import * as appregistry from 'aws-cdk-lib/aws-servicecatalogappregistry';
import * as crypto from 'crypto';
import { Construct } from 'constructs';
import {
  getAuthMode,
  getContextCountryList,
  getContextNumber,
  isContextEnabled,
} from './context';
import { CdnConstruct } from './constructs/cdn';
import { CognitoEdgeAuthStack } from './cognito-edge-auth-stack';
import { ComputeConstruct } from './constructs/compute';
import { DatabaseConstruct } from './constructs/database';
import { NetworkingConstruct } from './constructs/networking';
import { QueuesConstruct } from './constructs/queues';
import { StorageConstruct } from './constructs/storage';
import { WafStack } from './waf-stack';

export class MinuteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const enableCdn = isContextEnabled(this, 'minute:enableCdn');
    const authMode = getAuthMode(this);
    if (authMode === 'cognito' && !enableCdn) {
      throw new Error('minute:authMode=cognito requires minute:enableCdn=true');
    }

    const restrictAlbToCloudFront = isContextEnabled(
      this,
      'minute:restrictAlbToCloudFront',
      enableCdn,
    );
    const enableWaf = enableCdn && isContextEnabled(this, 'minute:enableWaf', true);
    const enableSecurityHeaders = enableCdn
      && isContextEnabled(this, 'minute:enableSecurityHeaders', true);
    const geoAllowlist = enableCdn
      ? getContextCountryList(this, 'minute:geoAllowlist', ['GB'])
      : [];
    const wafRateLimit = getContextNumber(this, 'minute:wafRateLimit', 300);
    const wafRateWindowSec = getContextNumber(this, 'minute:wafRateWindowSec', 60);

    cdk.Tags.of(this).add('Project', 'ndx-try-aws-scenarios');
    cdk.Tags.of(this).add('Scenario', 'minute');

    const appRegistryApp = new appregistry.CfnApplication(this, 'AppRegistryApplication', {
      name: `NDXTry_Minute_${this.account}`,
      description: 'NDX:Try - Minute AI Meeting Transcription & Minuting',
      tags: { Project: 'ndx-try', Scenario: 'minute' },
    });

    new appregistry.CfnResourceAssociation(this, 'AppRegistryAssociation', {
      application: appRegistryApp.attrId,
      resource: this.stackId,
      resourceType: 'CFN_STACK',
    });

    cdk.Tags.of(this).add('awsApplication', appRegistryApp.attrArn, {
      excludeResourceTypes: [
        'AWS::ServiceCatalogAppRegistry::Application',
        'AWS::ServiceCatalogAppRegistry::ResourceAssociation',
        'aws:cdk:stack',
      ],
    });

    const networking = new NetworkingConstruct(this, 'Networking', {
      restrictAlbToCloudFront,
    });

    const database = new DatabaseConstruct(this, 'Database', {
      vpc: networking.vpc,
      securityGroup: networking.auroraSecurityGroup,
    });

    const queues = new QueuesConstruct(this, 'Queues');
    const storage = new StorageConstruct(this, 'Storage');

    const compute = new ComputeConstruct(this, 'Compute', {
      vpc: networking.vpc,
      albSecurityGroup: networking.albSecurityGroup,
      fargateSecurityGroup: networking.fargateSecurityGroup,
      databaseCluster: database.cluster,
      databaseSecret: database.secret,
      dataBucket: storage.dataBucket,
      transcriptionQueue: queues.transcriptionQueue,
      transcriptionDlq: queues.transcriptionDlq,
      llmQueue: queues.llmQueue,
      llmDlq: queues.llmDlq,
    });

    if (enableCdn) {
      const cognitoEdgeAuth = authMode === 'cognito'
        ? new CognitoEdgeAuthStack(cdk.App.of(this)!, 'MinuteStackEdgeAuth', {
          stackName: `${this.stackName}-edge-auth`,
          env: { account: this.account, region: 'us-east-1' },
          synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
          description: 'Minute AI Lambda@Edge (Cognito auth) — deploys to us-east-1',
        })
        : undefined;

      const wafStack = enableWaf
        ? new WafStack(cdk.App.of(this)!, 'MinuteStackWaf', {
          stackName: `${this.stackName}-waf`,
          env: { account: this.account, region: 'us-east-1' },
          synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
          description: 'Minute AI CloudFront WAF — deploys to us-east-1',
          rateLimit: wafRateLimit,
          rateWindowSec: wafRateWindowSec,
        })
        : undefined;

      const cdn = new CdnConstruct(this, 'CDN', {
        loadBalancer: compute.loadBalancer,
        webAcl: wafStack?.waf.webAcl,
        geoAllowlist,
        enableSecurityHeaders,
        authMode,
        cognitoEdgeAuth,
      });

      storage.addBrowserOrigin(`https://${cdn.domainName}`);

      new cdk.CfnOutput(this, 'MinuteUrl', {
        description: authMode === 'cognito'
          ? 'URL to access Minute AI (HTTPS). Unauthenticated users are redirected to Cognito.'
          : 'URL to access Minute AI (HTTPS). Requires an active session; use MinuteLoginUrl first.',
        value: `https://${cdn.domainName}`,
        exportName: `${this.stackName}-MinuteUrl`,
      });

      if (authMode === 'magic-link') {
        new cdk.CfnOutput(this, 'MinuteLoginUrl', {
          description: 'Paste this URL into your browser to start a Minute AI session (7-day cookie)',
          value: `https://${cdn.domainName}/?key=${cdn.authToken}`,
        });

        new cdk.CfnOutput(this, 'MinuteAuthToken', {
          description: 'Raw auth token for Minute AI (the ?key= value in MinuteLoginUrl). Redeploy the stack to rotate.',
          value: cdn.authToken,
        });
      } else if (cognitoEdgeAuth && cdn.cognitoSignInUrl) {
        const cognitoAuth = cognitoEdgeAuth.cognitoAuth;
        new cdk.CfnOutput(this, 'MinuteCognitoSignInUrl', {
          description: 'Cognito hosted UI sign-in URL for Minute AI',
          value: cdn.cognitoSignInUrl,
        });

        new cdk.CfnOutput(this, 'CognitoUserPoolId', {
          description: 'Cognito User Pool ID (us-east-1)',
          value: cognitoAuth.userPool.userPoolId,
        });

        new cdk.CfnOutput(this, 'CognitoUserPoolClientId', {
          description: 'Cognito app client ID (CloudFront / Lambda@Edge)',
          value: cdn.userPoolClientId ?? '',
        });

        new cdk.CfnOutput(this, 'CognitoAdminUsername', {
          description: 'Bootstrap Cognito admin username',
          value: cognitoAuth.adminUsername,
        });

        new cdk.CfnOutput(this, 'CognitoAdminPassword', {
          description: 'Bootstrap Cognito admin password (rotate after first login)',
          value: cognitoAuth.adminPassword,
        });
      }
    } else {
      const albUrl = `http://${compute.loadBalancerDnsName}`;
      storage.addBrowserOrigin(albUrl);

      new cdk.CfnOutput(this, 'MinuteUrl', {
        description: 'Direct ALB URL (HTTP only; no edge auth until CloudFront is added)',
        value: albUrl,
        exportName: `${this.stackName}-MinuteUrl`,
      });

      new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
        description: 'ALB DNS name — use as the CloudFront origin when adding a distribution manually',
        value: compute.loadBalancerDnsName,
      });
    }

    new cdk.CfnOutput(this, 'CloudWatchLogsUrl', {
      description: 'CloudWatch Logs URL',
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:log-groups/log-group/${encodeURIComponent(`/ndx-minute-${this.stackName}`)}`,
    });

    new cdk.CfnOutput(this, 'DataBucketName', {
      description: 'S3 bucket for audio data',
      value: storage.dataBucket.bucketName,
    });
  }

  protected override _toCloudFormation(): object {
    const template = super._toCloudFormation() as any;

    if (template.Resources) {
      for (const [logicalId, resource] of Object.entries(template.Resources) as any[]) {
        if (resource.Type === 'AWS::IAM::Role') {
          const props = resource.Properties;
          if (props.RoleName && typeof props.RoleName === 'string' &&
              props.RoleName.startsWith('InnovationSandbox-ndx-')) {
            continue;
          }

          const hash = crypto.createHash('md5').update(logicalId).digest('hex').substring(0, 8);
          const meaningful = logicalId
            .replace(/[A-F0-9]{8}$/, '')
            .replace(/[^a-zA-Z0-9-]/g, '')
            .slice(-33);
          props.RoleName = `InnovationSandbox-ndx-${meaningful}-${hash}`;
        }
      }
    }

    return template;
  }
}
