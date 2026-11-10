import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), '
  + 'encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), '
  + 'magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), '
  + 'publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), '
  + 'xr-spatial-tracking=()';

/**
 * CSP tuned for the Minute Next.js SPA:
 * - connect-src / media-src include regional + global S3 for presigned audio uploads/downloads
 * - unsafe-inline on script/style for Next.js production bundles
 * - blob: for in-browser audio playback
 */
export function buildMinuteContentSecurityPolicy(region: string): string {
  const regionalS3 = `https://*.s3.${region}.amazonaws.com`;
  const globalS3 = 'https://*.s3.amazonaws.com';
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${regionalS3} ${globalS3} blob:`,
    `media-src 'self' blob: ${regionalS3} ${globalS3}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    'upgrade-insecure-requests',
  ].join('; ') + ';';
}

export class SecurityHeadersConstruct extends Construct {
  public readonly policy: cloudfront.ResponseHeadersPolicy;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;

    this.policy = new cloudfront.ResponseHeadersPolicy(this, 'Policy', {
      responseHeadersPolicyName: `NdxMinute-SecurityHeaders-${cdk.Aws.ACCOUNT_ID}`,
      comment: 'Minute-safe security headers (CSP allows S3 presigned audio)',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: buildMinuteContentSecurityPolicy(region),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(31_536_000),
          includeSubdomains: true,
          preload: false,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: PERMISSIONS_POLICY,
            override: true,
          },
        ],
      },
      removeHeaders: ['Server'],
    });
  }
}
