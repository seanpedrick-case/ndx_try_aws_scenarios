import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WafConstruct } from './constructs/waf';

export interface WafStackProps extends cdk.StackProps {
  readonly rateLimit: number;
  readonly rateWindowSec: number;
}

/**
 * CloudFront-scoped WAF Web ACLs must be created in us-east-1.
 * The main Minute stack references this ACL by ARN on the distribution.
 */
export class WafStack extends cdk.Stack {
  public readonly waf: WafConstruct;

  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, props);

    this.waf = new WafConstruct(this, 'WAF', {
      rateLimit: props.rateLimit,
      rateWindowSec: props.rateWindowSec,
    });
  }
}
