# ISB Blueprint Registration: Council Chatbot

Register the NDX:Try Council Chatbot scenario as an Innovation Sandbox (ISB) blueprint so it auto-deploys into sandbox accounts when leases are approved.

## Prerequisites

- AWS Innovation Sandbox deployed in the hub account
- Hub account ID known (referred to as `{HUB_ACCOUNT_ID}` below)
- ISB namespace known (referred to as `{NAMESPACE}` below)
- An S3 bucket accessible from the hub account for hosting the template (referred to as `{BUCKET}` in region `{REGION}`)
- Amazon Bedrock model `amazon.nova-pro-v1:0` enabled in `us-east-1` in sandbox accounts
- Amazon Bedrock model `amazon.titan-embed-text-v2:0` enabled in `us-east-1` in sandbox accounts

## Step 1 — Upload Template to S3

Upload the CloudFormation template to an S3 bucket accessible from the hub account:

```bash
aws s3 cp template.yaml \
  s3://{BUCKET}/scenarios/council-chatbot/template.yaml
```

## Step 2 — Create StackSet

Create a self-managed CloudFormation StackSet using ISB's roles. The StackSet must be created in the same region as your ISB deployment (e.g. `us-west-2`):

```bash
aws cloudformation create-stack-set \
  --stack-set-name ndx-try-council-chatbot \
  --template-url https://{BUCKET}.s3.{REGION}.amazonaws.com/scenarios/council-chatbot/template.yaml \
  --administration-role-arn arn:aws:iam::{HUB_ACCOUNT_ID}:role/InnovationSandbox-{NAMESPACE}-IntermediateRole \
  --execution-role-name InnovationSandbox-{NAMESPACE}-SandboxAccountRole \
  --managed-execution Active=true \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --description "NDX:Try Council Chatbot - AI-powered resident Q&A assistant"
```

Notes:
- `CAPABILITY_NAMED_IAM` is required because the template uses explicit IAM role names
- `CAPABILITY_AUTO_EXPAND` is required because the template uses the SAM transform (`AWS::Serverless-2016-10-31`)
- `--managed-execution Active=true` is recommended for concurrent lease handling
- Blueprint name must match pattern `^[a-zA-Z][a-zA-Z0-9-]{0,49}$`

If you are not deploying into an Innovation Sandbox (ISB) or StackSet workflow, you can use the following command. `deploy` accepts a local template file and can be run again to update the stack:
```bash
aws cloudformation deploy `
  --stack-name ndx-try-council-chatbot `
  --template-url https://YOUR_BUCKET.s3.YOUR_BUCKET_REGION.amazonaws.com/scenarios/council-chatbot/template.yaml `
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides Environment=sandbox `
  --region YOUR_DEPLOYMENT_REGION
```

You can also use the template file locally (Powershell, replace ` with ^ if using cmd):
```bash
aws cloudformation deploy `
  --stack-name ndx-try-council-chatbot `
  --template-file .\\cloudformation\\scenarios\\council-chatbot\\template.yaml `
  --s3-bucket lambet-ndx-try-council-chatbot `
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides Environment=sandbox `
  --region eu-west-2
```

Then monitor it with the following:

```bash
aws cloudformation wait stack-create-complete `
  --stack-name ndx-try-council-chatbot `
  --region us-east-1

aws cloudformation describe-stacks `
  --stack-name ndx-try-council-chatbot `
  --query "Stacks[0].Outputs"
```

## Step 3 — Register in ISB

1. Navigate to ISB admin console > **Blueprints** > **Register New Blueprint**
2. Enter name: `ndx-try-council-chatbot` (must be 1-50 chars, start with letter, alphanumeric + hyphens only)
3. Select the `ndx-try-council-chatbot` StackSet
4. Configure deployment:
   - Select target regions (template is designed for `us-east-1` due to Bedrock model availability)
   - Set timeout: **20 minutes** recommended for this lightweight template
5. Review and submit

## Step 4 — Associate with Lease Template

1. In ISB admin console, navigate to **Lease Templates**
2. Edit an existing lease template or create a new one
3. In the blueprint selection step, select `ndx-try-council-chatbot`
4. Save the lease template

## Verification

1. Request a test lease using the lease template from Step 4
2. Wait for lease approval and blueprint deployment (should complete within 15 minutes)
3. Check the sandbox account for:
   - Lambda function `ndx-try-chatbot-handler-{region}`
   - S3 bucket `ndx-try-chatbot-kb-{account-id}-{region}`
   - IAM role `ndx-try-chatbot-role-{region}`
   - Bedrock Guardrail is READY (`ndx-try-council-guardrail-{region}`)
   - Sample council documents seeded in S3 bucket under `documents/` prefix
   - Bedrock Knowledge Base status is ACTIVE
   - Data source sync completed successfully (31 documents indexed)
   - Knowledge Base ID visible in stack outputs
4. Open the Lambda Function URL and verify the chatbot responds to queries
5. Terminate the test lease and verify ISB cleans up all resources via AWS Nuke
