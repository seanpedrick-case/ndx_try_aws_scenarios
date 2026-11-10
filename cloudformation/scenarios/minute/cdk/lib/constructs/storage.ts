import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface StorageConstructProps {}

const BROWSER_CORS_METHODS = [
  s3.HttpMethods.GET,
  s3.HttpMethods.PUT,
  s3.HttpMethods.POST,
  s3.HttpMethods.DELETE,
  s3.HttpMethods.HEAD,
];

const BROWSER_CORS_HEADERS = ['*'];

const BROWSER_CORS_EXPOSED_HEADERS = [
  'ETag',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
];

export class StorageConstruct extends Construct {
  public readonly dataBucket: s3.Bucket;

  constructor(scope: Construct, id: string, _props?: StorageConstructProps) {
    super(scope, id);

    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      cors: [
        {
          allowedMethods: BROWSER_CORS_METHODS,
          allowedOrigins: ['*'],
          allowedHeaders: BROWSER_CORS_HEADERS,
          exposedHeaders: BROWSER_CORS_EXPOSED_HEADERS,
          maxAge: 3600,
        },
      ],
    });

    // Allow AWS Transcribe to read/write audio files
    this.dataBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('transcribe.amazonaws.com')],
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`${this.dataBucket.bucketArn}/*`],
      }),
    );
  }

  /** Pin the browser-facing origin for direct-to-S3 uploads/downloads. */
  public addBrowserOrigin(origin: string): void {
    this.dataBucket.addCorsRule({
      allowedMethods: BROWSER_CORS_METHODS,
      allowedOrigins: [origin],
      allowedHeaders: BROWSER_CORS_HEADERS,
      exposedHeaders: BROWSER_CORS_EXPOSED_HEADERS,
      maxAge: 3600,
    });
  }
}
