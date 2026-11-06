import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkingConstructProps {
  /** When true, ALB accepts HTTP only from the CloudFront managed prefix list. */
  readonly restrictAlbToCloudFront?: boolean;
}

/**
 * CloudFront origin-facing managed prefix list IDs by region.
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/LocationsOfEdgeServers.html
 * Override a single region via context `minute:cloudFrontPrefixListId`, or the whole
 * map via `minute:cloudFrontPrefixListMap` (object of region → pl-…).
 */
const DEFAULT_CLOUDFRONT_PREFIX_LIST_BY_REGION: Record<string, string> = {
  'ap-northeast-1': 'pl-58a04531',
  'ap-northeast-2': 'pl-22a6434b',
  'ap-south-1': 'pl-9aa247f3',
  'ap-southeast-1': 'pl-31a34658',
  'ap-southeast-2': 'pl-4fa04526',
  'ca-central-1': 'pl-38a64358',
  'eu-central-1': 'pl-4fa04526',
  'eu-north-1': 'pl-4fa04526',
  'eu-west-1': 'pl-4fa04526',
  'eu-west-2': 'pl-7ca54015',
  'eu-west-3': 'pl-4fa04526',
  'sa-east-1': 'pl-5da64350',
  'us-east-1': 'pl-3b927c52',
  'us-east-2': 'pl-4fa04526',
  'us-west-1': 'pl-4fa04526',
  'us-west-2': 'pl-82a045eb',
};

function resolveCloudFrontPrefixListId(scope: Construct): string {
  const singleOverride = scope.node.tryGetContext('minute:cloudFrontPrefixListId');
  if (singleOverride) {
    return String(singleOverride);
  }

  const mapOverride = scope.node.tryGetContext('minute:cloudFrontPrefixListMap') as
    | Record<string, string>
    | undefined;
  const mapping = { ...DEFAULT_CLOUDFRONT_PREFIX_LIST_BY_REGION, ...mapOverride };

  const cfnMapping = new cdk.CfnMapping(scope, 'CloudFrontPrefixListIds', {
    mapping: Object.fromEntries(
      Object.entries(mapping).map(([region, id]) => [region, { PrefixListId: id }]),
    ),
  });

  return cfnMapping.findInMap(cdk.Aws.REGION, 'PrefixListId');
}

export class NetworkingConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly fargateSecurityGroup: ec2.SecurityGroup;
  public readonly auroraSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkingConstructProps = {}) {
    super(scope, id);

    const prefix = 'NdxMinute';

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${prefix}-VPC`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-ALB-SG`,
      description: 'ALB security group for Minute AI',
      allowAllOutbound: false,
    });

    if (props.restrictAlbToCloudFront) {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.prefixList(resolveCloudFrontPrefixListId(this)),
        ec2.Port.tcp(80),
        'Allow HTTP from CloudFront only',
      );
    } else {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'Allow HTTP from internet',
      );
    }

    this.fargateSecurityGroup = new ec2.SecurityGroup(this, 'FargateSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-Fargate-SG`,
      description: 'Fargate task security group for Minute AI',
      allowAllOutbound: true,
    });

    this.fargateSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(8081),
      'Allow HTTP from ALB to frontend',
    );

    this.albSecurityGroup.addEgressRule(
      this.fargateSecurityGroup,
      ec2.Port.tcp(8081),
      'Allow HTTP to frontend tasks',
    );

    this.fargateSecurityGroup.addIngressRule(
      this.fargateSecurityGroup,
      ec2.Port.tcp(8080),
      'Allow frontend to backend via Cloud Map',
    );

    this.auroraSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-Aurora-SG`,
      description: 'Aurora PostgreSQL security group for Minute AI',
      allowAllOutbound: false,
    });

    this.auroraSecurityGroup.addIngressRule(
      this.fargateSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from Fargate tasks',
    );
  }
}
