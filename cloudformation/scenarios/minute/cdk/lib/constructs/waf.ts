import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface WafConstructProps {
  readonly rateLimit: number;
  readonly rateWindowSec: number;
}

export class WafConstruct extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id);

    const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      metricName,
      sampledRequestsEnabled: true,
    });

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `NdxMinute-WAF-${cdk.Aws.ACCOUNT_ID}`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('NdxMinuteWaf'),
      rules: [
        {
          name: 'RateLimit',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.rateLimit,
              evaluationWindowSec: props.rateWindowSec,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: visibility('NdxMinuteWafRateLimit'),
        },
        {
          name: 'AWS-AWSManagedRulesAmazonIpReputationList',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: visibility('NdxMinuteWafIpReputation'),
        },
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              ruleActionOverrides: [
                {
                  name: 'SizeRestrictions_BODY',
                  actionToUse: { allow: {} },
                },
              ],
            },
          },
          visibilityConfig: visibility('NdxMinuteWafCommonRuleSet'),
        },
        {
          name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: visibility('NdxMinuteWafKnownBadInputs'),
        },
        {
          name: 'AWS-AWSManagedRulesSQLiRuleSet',
          priority: 4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
          visibilityConfig: visibility('NdxMinuteWafSqlInjection'),
        },
      ],
    });
  }
}
