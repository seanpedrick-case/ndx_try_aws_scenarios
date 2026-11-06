import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

// GHCR public images (built by .github/workflows/docker-build-minute.yml).
// Pins follow the spec's "own GHCR" pattern: <repo>:sha-<7chars>@sha256:<digest>.
// Renovate tracks both via the regex in renovate.json.
const FRONTEND_IMAGE = 'ghcr.io/co-cddo/ndx_try_aws_scenarios-minute_frontend:sha-5d3d423@sha256:0cfbf3bca86f2360935765dc5ae33e9cbcc88d96ad2d58fd5c9d0a5b99862abf';
const BACKEND_IMAGE = 'ghcr.io/co-cddo/ndx_try_aws_scenarios-minute_backend:sha-5d3d423@sha256:0830ab1fe636764380c0eb2ea56530abfff6658a694f3550f9dda2eddb48517b';
const WORKER_IMAGE = 'ghcr.io/co-cddo/ndx_try_aws_scenarios-minute_worker:sha-5d3d423@sha256:13d7800495c7268cd75170649025e6a7f98bf12cdd2e87cbdab5ddbef5d76a65';

export interface ComputeConstructProps {
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly fargateSecurityGroup: ec2.ISecurityGroup;
  readonly databaseCluster: rds.IDatabaseCluster;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly dataBucket: s3.IBucket;
  readonly transcriptionQueue: sqs.IQueue;
  readonly transcriptionDlq: sqs.IQueue;
  readonly llmQueue: sqs.IQueue;
  readonly llmDlq: sqs.IQueue;
}

export class ComputeConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly loadBalancerDnsName: string;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    // ==========================================================================
    // ECS Cluster
    // ==========================================================================
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'NdxMinute',
    });

    // ==========================================================================
    // Cloud Map Namespace for service discovery
    // ==========================================================================
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'minute-internal',
      vpc: props.vpc,
    });

    // ==========================================================================
    // CloudWatch Log Group
    // ==========================================================================
    // Stack-name suffix keeps the LogGroup unique across redeploys: a
    // failed-deploy + rollback that leaves the LG orphaned (CFN believes it
    // owns the name, but the next stack creation collides on AlreadyExists)
    // is the most common smoke-account failure mode without the suffix.
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ndx-minute-${cdk.Stack.of(this).stackName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ==========================================================================
    // Shared Execution Role (image pull + logging)
    // ==========================================================================
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'InnovationSandbox-ndx-minute-exec',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Allow reading database secret
    props.databaseSecret.grantRead(executionRole);

    // GHCR images are public — no pull auth needed

    // ==========================================================================
    // Backend Task Role
    // ==========================================================================
    const backendTaskRole = new iam.Role(this, 'BackendTaskRole', {
      roleName: 'InnovationSandbox-ndx-minute-backend-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // S3 access for audio files
    props.dataBucket.grantReadWrite(backendTaskRole);

    // SQS access to send messages (including DLQs — backend initializes all queue URLs at startup)
    props.transcriptionQueue.grantSendMessages(backendTaskRole);
    props.transcriptionDlq.grantSendMessages(backendTaskRole);
    props.llmQueue.grantSendMessages(backendTaskRole);
    props.llmDlq.grantSendMessages(backendTaskRole);

    // CloudWatch Logs
    backendTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.logGroup.logGroupArn],
    }));

    // ==========================================================================
    // Worker Task Role
    // ==========================================================================
    const workerTaskRole = new iam.Role(this, 'WorkerTaskRole', {
      roleName: 'InnovationSandbox-ndx-minute-worker-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // S3 access
    props.dataBucket.grantReadWrite(workerTaskRole);

    // SQS access to consume + send messages
    props.transcriptionQueue.grantConsumeMessages(workerTaskRole);
    props.transcriptionQueue.grantSendMessages(workerTaskRole);
    props.llmQueue.grantConsumeMessages(workerTaskRole);
    props.llmQueue.grantSendMessages(workerTaskRole);
    props.transcriptionDlq.grantSendMessages(workerTaskRole);
    props.llmDlq.grantSendMessages(workerTaskRole);

    // Bedrock permissions
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
        'arn:aws:bedrock:*::foundation-model/amazon.nova-*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    }));

    // Marketplace permissions (model agreement acceptance)
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    }));

    // AWS Transcribe permissions
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
      ],
      resources: ['*'],
    }));

    // CloudWatch Logs
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.logGroup.logGroupArn],
    }));

    // ==========================================================================
    // Frontend Task Role (minimal)
    // ==========================================================================
    const frontendTaskRole = new iam.Role(this, 'FrontendTaskRole', {
      roleName: 'InnovationSandbox-ndx-minute-frontend-task',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    frontendTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.logGroup.logGroupArn],
    }));

    // ==========================================================================
    // Shared environment variables
    // ==========================================================================
    const dbHost = props.databaseCluster.clusterEndpoint.hostname;
    const dbPort = props.databaseCluster.clusterEndpoint.port.toString();

    const sharedEnv: Record<string, string> = {
      ENVIRONMENT: 'local', // Bypass auth (dummy user) for v1
      POSTGRES_HOST: dbHost,
      POSTGRES_PORT: dbPort,
      POSTGRES_DB: 'minute_db',
      POSTGRES_USER: props.databaseSecret.secretValueFromJson('username').unsafeUnwrap(),
      POSTGRES_PASSWORD: props.databaseSecret.secretValueFromJson('password').unsafeUnwrap(),
      DATA_S3_BUCKET: props.dataBucket.bucketName,
      TRANSCRIPTION_QUEUE_NAME: props.transcriptionQueue.queueName,
      TRANSCRIPTION_DEADLETTER_QUEUE_NAME: props.transcriptionDlq.queueName,
      LLM_QUEUE_NAME: props.llmQueue.queueName,
      LLM_DEADLETTER_QUEUE_NAME: props.llmDlq.queueName,
      QUEUE_SERVICE_NAME: 'sqs',
      STORAGE_SERVICE_NAME: 's3',
      AWS_DEFAULT_REGION: cdk.Aws.REGION,
      AWS_REGION: cdk.Aws.REGION,
      AWS_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
      // Regional S3 endpoint — presigned URLs must not use the global
      // s3.amazonaws.com hostname or browsers report CORS failures on redirect.
      AWS_ENDPOINT_URL_S3: `https://s3.${cdk.Aws.REGION}.amazonaws.com`,
      // Required by Settings but not used in local/bedrock mode
      USE_LOCALSTACK: 'false',
    };

    // ==========================================================================
    // Backend Task Definition + Service
    // ==========================================================================
    const backendTaskDef = new ecs.FargateTaskDefinition(this, 'BackendTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole,
      taskRole: backendTaskRole,
    });

    backendTaskDef.addContainer('backend', {
      image: ecs.ContainerImage.fromRegistry(BACKEND_IMAGE),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'backend',
      }),
      environment: {
        ...sharedEnv,
        PORT: '8080',
        REPO: 'minute',
      },
      portMappings: [{
        containerPort: 8080,
        protocol: ecs.Protocol.TCP,
      }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/healthcheck || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(300),
      },
    });

    const backendService = new ecs.FargateService(this, 'BackendService', {
      cluster: this.cluster,
      taskDefinition: backendTaskDef,
      desiredCount: 1,
      securityGroups: [props.fargateSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      // No circuit breaker — let CloudFormation wait for stabilization
      serviceName: 'NdxMinute-Backend',
      healthCheckGracePeriod: cdk.Duration.minutes(15),
      cloudMapOptions: {
        name: 'minute-backend',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ==========================================================================
    // Worker Task Definition + Service
    // ==========================================================================
    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu: 2048,
      memoryLimitMiB: 8192, // Extra for Ray tmpfs
      executionRole,
      taskRole: workerTaskRole,
    });

    const workerContainer = workerTaskDef.addContainer('worker', {
      image: ecs.ContainerImage.fromRegistry(WORKER_IMAGE),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'worker',
      }),
      environment: {
        ...sharedEnv,
        REPO: 'minute',
        FAST_LLM_PROVIDER: 'bedrock',
        BEST_LLM_PROVIDER: 'bedrock',
        FAST_LLM_MODEL_NAME: 'amazon.nova-lite-v1:0',
        BEST_LLM_MODEL_NAME: 'amazon.nova-pro-v1:0',
        TRANSCRIPTION_SERVICES: '["aws_transcribe"]',
        MAX_TRANSCRIPTION_PROCESSES: '2',
        MAX_LLM_PROCESSES: '2',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'pgrep -f "worker" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(300),
      },
    });

    // tmpfs mount for Ray shared memory
    const cfnWorkerTaskDef = workerTaskDef.node.defaultChild as ecs.CfnTaskDefinition;
    const containerDefs = cfnWorkerTaskDef.containerDefinitions as any[];
    if (containerDefs && containerDefs[0]) {
      containerDefs[0].linuxParameters = {
        tmpfs: [{
          containerPath: '/dev/shm',
          size: 4096, // 4GB
        }],
      };
    }

    new ecs.FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      taskDefinition: workerTaskDef,
      desiredCount: 1,
      securityGroups: [props.fargateSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      // No circuit breaker — let CloudFormation wait for stabilization
      serviceName: 'NdxMinute-Worker',
    });

    // ==========================================================================
    // Frontend Task Definition + Service
    // ==========================================================================
    const frontendTaskDef = new ecs.FargateTaskDefinition(this, 'FrontendTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole: frontendTaskRole,
    });

    frontendTaskDef.addContainer('frontend', {
      image: ecs.ContainerImage.fromRegistry(FRONTEND_IMAGE),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'frontend',
      }),
      environment: {
        ...sharedEnv,
        PORT: '8081',
        NODE_ENV: 'production',
        BACKEND_HOST: 'http://minute-backend.minute-internal:8080',
      },
      portMappings: [{
        containerPort: 8081,
        protocol: ecs.Protocol.TCP,
      }],
    });

    const frontendService = new ecs.FargateService(this, 'FrontendService', {
      cluster: this.cluster,
      taskDefinition: frontendTaskDef,
      desiredCount: 1,
      securityGroups: [props.fargateSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      enableExecuteCommand: true,
      // No circuit breaker — let CloudFormation wait for stabilization
      serviceName: 'NdxMinute-Frontend',
      healthCheckGracePeriod: cdk.Duration.minutes(5),
    });

    // ==========================================================================
    // Application Load Balancer
    // ==========================================================================
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      loadBalancerName: 'NdxMinute-ALB',
    });

    const httpListener = this.loadBalancer.addListener('HTTP', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'Service starting...',
      }),
    });

    httpListener.addTargets('FrontendTarget', {
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      port: 8081,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [frontendService],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: '200-399',
      },
    });

    this.loadBalancerDnsName = this.loadBalancer.loadBalancerDnsName;
  }
}
