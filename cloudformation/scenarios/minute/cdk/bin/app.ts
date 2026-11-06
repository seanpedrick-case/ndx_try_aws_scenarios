#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getAuthMode, isContextEnabled } from '../lib/context';
import { MinuteStack } from '../lib/minute-stack';

const app = new cdk.App();
const authMode = getAuthMode(app);
const enableCdn = isContextEnabled(app, 'minute:enableCdn');
const enableWaf = enableCdn && isContextEnabled(app, 'minute:enableWaf', true);

// Cross-region references to us-east-1 (CloudFront WAF and/or Cognito Lambda@Edge)
// require an explicit env on the main stack.
const needsExplicitEnv = authMode === 'cognito' || (enableCdn && enableWaf);
const stackEnv = needsExplicitEnv
  ? {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  }
  : undefined;

new MinuteStack(app, 'MinuteStack', {
  env: stackEnv,
  description: 'Minute AI - Meeting Transcription & Minuting on AWS',
  synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
});
