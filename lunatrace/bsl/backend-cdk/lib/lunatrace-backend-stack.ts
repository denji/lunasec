/*
 * Copyright by LunaSec (owned by Refinery Labs, Inc)
 *
 * Licensed under the Business Source License v1.1
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at
 *
 * https://github.com/lunasec-io/lunasec/blob/master/licenses/BSL-LunaTrace.txt
 *
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { inspect } from 'util';

import * as cdk from 'aws-cdk-lib';
import { aws_ecs_patterns, Duration } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerDependencyCondition,
  ContainerImage,
  DeploymentControllerType,
  Secret as EcsSecret,
  FargateTaskDefinition,
  LogDriver,
} from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationProtocol, ListenerCondition, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { DnsRecordType, PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

import { StackInputs } from '../inputs/types';

import { baseEnvironmentVars, commonBuildProps } from './constants';
import { addDatadogToTaskDefinition, datadogLogDriverForService } from './datadog-fargate-integration';
import { WorkerStack } from './worker-stack';
import { WorkerStorageStack } from './worker-storage-stack';

type LunaTraceStackProps = cdk.StackProps & StackInputs;

// Handles far more than just the backend, in reality this is the "root stack" that launches all other sub-stacks
// TODO: rename this to "RootStack"
export class LunatraceBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LunaTraceStackProps) {
    super(scope, id, props);

    const publicBaseUrl = `https://${props.domainName}`;
    const publicHasuraServiceUrl = `${publicBaseUrl}/api/service/v1/graphql`;

    const vpc = Vpc.fromLookup(this, 'Vpc', {
      vpcId: props.vpcId,
    });

    const namespace = new PrivateDnsNamespace(this, 'ServiceDiscoveryNamespace', {
      name: 'services',
      vpc,
    });

    const dbSecurityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      'DatabaseClusterSecurityGroup',
      props.dbSecurityGroup
    );

    const vpcDbSecurityGroup = new SecurityGroup(this, 'sg', {
      vpc: vpc,
      securityGroupName: 'LunaTrace VPC database connection',
    });
    dbSecurityGroup.addIngressRule(vpcDbSecurityGroup, Port.tcp(5432), 'LunaTrace VPC database connection');

    const servicesSecurityGroup = new SecurityGroup(this, 'ServicesSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    const oryConfigBucket = Bucket.fromBucketArn(this, 'OryConfig', props.oathkeeperConfigBucketArn);
    const oathkeeperJwksFile = 'lunatrace-oathkeeper.2022-05-13.jwks.json';

    // TODO (cthompson) This is highly annoying. Since we cannot mount files in an ECS container, we need to somehow get
    // the jwks config into oathkeeper. To hack our way into making this happen, we are writing the jwks.json file into
    // an s3 bucket and then referencing that as an s3 url from inside the oathkeeper config.

    // generated with:
    // oathkeeper credentials generate --alg RS256 > jwks.json
    // aws secretsmanager create-secret --name lunatrace-OathkeeperJwks --description "Jwks key details for LunaTrace Oathkeeper" --secret-string '$(cat jwks.json)'
    // const oathkeeperJwksSecret = Secret.fromSecretNameV2(this, 'OathkeeperJwks', 'lunatrace-OathkeeperJwks');

    // new BucketDeployment(this, 'DeployWebsite', {
    //   sources: [Source.asset('../ory/oathkeeper')],
    //   // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //   // @ts-ignore
    //   destinationBucket: oryConfigBucket,
    // });

    const domainZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.domainZoneId,
      zoneName: props.domainName,
    });

    const certificate = Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);

    const hasuraDatabaseUrlSecret = Secret.fromSecretCompleteArn(
      this,
      'HasuraDatabaseUrlSecret',
      props.databaseSecretArn
    );

    const hasuraAdminSecret = Secret.fromSecretCompleteArn(this, 'HasuraAdminSecret', props.hasuraAdminSecretArn);

    const backendStaticSecret = Secret.fromSecretCompleteArn(this, 'BackendStaticSecret', props.backendStaticSecretArn);
    const gitHubAppPrivateKey = Secret.fromSecretCompleteArn(this, 'GitHubAppPrivateKey', props.gitHubAppPrivateKey);
    const gitHubAppWebHookSecret = Secret.fromSecretCompleteArn(
      this,
      'GitHubAppWebHookSecret',
      props.gitHubAppWebHookSecret
    );
    const discordWebhookUrlSecret = Secret.fromSecretCompleteArn(
      this,
      'DiscordWebhookUrlSecret',
      props.discordWebhookUrlArn
    );

    const storageStackStage = WorkerStorageStack.createWorkerStorageStack(this, {
      env: props.env,
      publicBaseUrl,
    });

    if (
      !storageStackStage.processRepositorySqsQueue ||
      !storageStackStage.processWebhookSqsQueue ||
      !storageStackStage.processManifestSqsQueue ||
      !storageStackStage.staticAnalysisSqsQueue ||
      !storageStackStage.processSbomSqsQueue
    ) {
      throw new Error(`expected non-null storage stack queues: ${inspect(storageStackStage)}`);
    }

    const execRole = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    execRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser'));

    const taskDef = new FargateTaskDefinition(this, 'TaskDefinition', {
      family: 'LunaTraceAppTaskDefinition',
      cpu: 4096,
      memoryLimitMiB: 8192,
      executionRole: execRole,
    });

    addDatadogToTaskDefinition(this, taskDef, props.datadogApiKeyArn);

    const frontendContainerImage = ContainerImage.fromAsset('../frontend', {
      ...commonBuildProps,
      buildArgs: {
        REACT_APP_BASE_URL: `https://${props.domainName}`,
        REACT_APP_GRAPHQL_URL: `https://${props.domainName}/v1/graphql`,
        REACT_APP_KRATOS_URL: `https://${props.domainName}/api/kratos`,
        REACT_APP_GITHUB_APP_LINK: props.gitHubAppLink,
      },
    });

    const frontend = taskDef.addContainer('FrontendContainer', {
      image: frontendContainerImage,
      containerName: 'LunaTraceFrontendContainer',
      portMappings: [{ containerPort: 80 }],
      logging: datadogLogDriverForService('lunatrace', 'frontend'),
      healthCheck: {
        command: ['CMD-SHELL', 'wget  --no-verbose --tries=1 --spider http://localhost || exit 1'],
      },
    });

    const oathkeeperContainerImage = ContainerImage.fromAsset('../ory', {
      ...commonBuildProps,
      file: 'docker/oathkeeper.dockerfile',
      buildArgs: {
        OATHKEEPER_FRONTEND_URL: 'http://localhost:3000',
        OATHKEEPER_BACKEND_URL: 'http://localhost:3002',
        OATHKEEPER_HASURA_URL: 'http://localhost:8080',
        OATHKEEPER_KRATOS_URL: 'http://localhost:4433',
        OATHKEEPER_MATCH_URL: `<https|http|ws>://<localhost:4455|${props.domainName}>`,
      },
    });

    const oathkeeper = taskDef.addContainer('OathkeeperContainer', {
      containerName: 'OathkeeperContainer',
      image: oathkeeperContainerImage,
      portMappings: [{ containerPort: 4455 }],
      logging: datadogLogDriverForService('lunatrace', 'oathkeeper'),
      entryPoint: ['oathkeeper', '--config', '/config/generated/config.yaml', 'serve'],
      environment: {
        ...baseEnvironmentVars,
        MUTATORS_ID_TOKEN_CONFIG_JWKS_URL: oryConfigBucket.s3UrlForObject(oathkeeperJwksFile),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:4456/health/ready || exit 1'],
      },
    });

    const kratosContainerImage = ContainerImage.fromAsset('../ory', {
      ...commonBuildProps,
      file: 'docker/kratos.dockerfile',
      buildArgs: {
        KRATOS_DOMAIN_NAME: props.domainName,
      },
    });

    const githubOauthAppLoginClientId = Secret.fromSecretCompleteArn(
      this,
      'GithubOauthAppLoginClientId',
      props.githubOauthAppLoginClientIdArn
    );
    const githubOauthAppLoginSecret = Secret.fromSecretCompleteArn(
      this,
      'GithubOauthAppLoginSecret',
      props.githubOauthAppLoginSecretArn
    );

    const kratosCookieSecret = Secret.fromSecretCompleteArn(this, 'KratosCookieSecret', props.kratosCookieSecretArn);
    const kratosCipherSecret = Secret.fromSecretCompleteArn(this, 'KratosCipherSecret', props.kratosCipherSecretArn);
    const kratosSlackSecret = Secret.fromSecretCompleteArn(this, 'KratosSlackSecret', props.kratosSlackSecretArn);

    const kratos = taskDef.addContainer('KratosContainer', {
      image: kratosContainerImage,
      portMappings: [{ containerPort: 4433 }],
      logging: datadogLogDriverForService('lunatrace', 'kratos'),
      entryPoint: [
        'kratos',
        '--config',
        '/config/config.yaml',
        '--config',
        '/config/generated/config.production.yaml',
        'serve',
      ],
      environment: {
        ...baseEnvironmentVars,
        // Set this to 'trace' if you need more data
        LOG_LEVEL: 'debug',
      },
      secrets: {
        DSN: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
        SELFSERVICE_METHODS_OIDC_CONFIG_PROVIDERS_0_CLIENT_ID:
          EcsSecret.fromSecretsManager(githubOauthAppLoginClientId),
        SELFSERVICE_METHODS_OIDC_CONFIG_PROVIDERS_0_CLIENT_SECRET:
          EcsSecret.fromSecretsManager(githubOauthAppLoginSecret),
        SECRETS_COOKIE: EcsSecret.fromSecretsManager(kratosCookieSecret),
        SECRETS_CIPHER: EcsSecret.fromSecretsManager(kratosCipherSecret),
        SELFSERVICE_FLOWS_REGISTRATION_AFTER_OIDC_HOOKS_0_CONFIG_URL: EcsSecret.fromSecretsManager(kratosSlackSecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:4434/health/ready || exit 1'],
      },
    });

    // These are used by the backend node container below, and also by the worker containers in the worker-stack
    const nodeEnvVars = {
      ...baseEnvironmentVars,
      NODE_ENV: 'production',
      WORKER_TYPE: 'queue-handler',
      PROCESS_WEBHOOK_QUEUE: storageStackStage.processWebhookSqsQueue.queueName,
      PROCESS_REPOSITORY_QUEUE: storageStackStage.processRepositorySqsQueue.queueName,
      STATIC_ANALYSIS_QUEUE: storageStackStage.staticAnalysisSqsQueue.queueName,
      S3_SBOM_BUCKET: storageStackStage.sbomBucket.bucketName,
      S3_MANIFEST_BUCKET: storageStackStage.manifestBucket.bucketName,
      S3_CODE_BUCKET: storageStackStage.codeBucket.bucketName,
      GITHUB_APP_ID: props.gitHubAppId,
      HASURA_URL: publicHasuraServiceUrl,
      LUNATRACE_GRAPHQL_SERVER_URL: 'http://backend.services:8080/v1/graphql',
      LUNATRACE_NPM_REGISTRY: 'http://backend.services:8081',
      QUEUE_VISIBILITY: '0', // overwritten by worker defs
      QUEUE_NAME: 'placeholder',
      SITE_PUBLIC_URL: publicBaseUrl,
      PORT: '3002',
    };

    const nodeSecrets = {
      DATABASE_CONNECTION_URL: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
      LUNATRACE_DB_DSN: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
      HASURA_GRAPHQL_DATABASE_URL: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
      HASURA_GRAPHQL_ADMIN_SECRET: EcsSecret.fromSecretsManager(hasuraAdminSecret),
      LUNATRACE_GRAPHQL_SERVER_SECRET: EcsSecret.fromSecretsManager(hasuraAdminSecret),
      STATIC_SECRET_ACCESS_TOKEN: EcsSecret.fromSecretsManager(backendStaticSecret),
      GITHUB_APP_PRIVATE_KEY: EcsSecret.fromSecretsManager(gitHubAppPrivateKey),
      GITHUB_APP_WEBHOOK_SECRET: EcsSecret.fromSecretsManager(gitHubAppWebHookSecret),
      DISCORD_WEBHOOK_URL_SECRET: EcsSecret.fromSecretsManager(discordWebhookUrlSecret),
    };

    const backendContainerImage = ContainerImage.fromAsset('../backend', {
      ...commonBuildProps,
      target: 'backend-express-server',
    });

    const backend = taskDef.addContainer('BackendContainer', {
      image: backendContainerImage,
      containerName: 'LunaTraceBackendContainer',
      portMappings: [{ containerPort: 3002 }],
      logging: datadogLogDriverForService('lunatrace', 'lunatrace-backend'),
      // If logs are missing from datadog, particularly failure-to-start logs, use this instead and go find the errors in cloudwatch,
      // not ecs
      // logging: LogDriver.awsLogs({
      //   streamPrefix: 'lunatrace-backend-tmp',
      // }),
      environment: nodeEnvVars,
      secrets: nodeSecrets,
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1'],
        timeout: Duration.minutes(1),
        startPeriod: Duration.seconds(300),
        retries: 10,
      },
    });
    storageStackStage.processRepositorySqsQueue.grantSendMessages(backend.taskDefinition.taskRole);

    const hasuraJwksEndpointConfig = {
      type: 'RS256',
      jwk_url: 'http://localhost:4456/.well-known/jwks.json',
      issuer: 'http://oathkeeper:4455/',
    };

    const hasuraContainerImage = ContainerImage.fromAsset('../hasura', {
      ...commonBuildProps,
    });

    const hasura = taskDef.addContainer('HasuraContainer', {
      image: hasuraContainerImage,
      portMappings: [{ containerPort: 8080 }],
      logging: datadogLogDriverForService('lunatrace', 'hasura'),
      environment: {
        ...baseEnvironmentVars,
        HASURA_GRAPHQL_CORS_DOMAIN: `${publicBaseUrl}, http://localhost:9695`,
        HASURA_GRAPHQL_ENABLE_CONSOLE: 'true',
        HASURA_GRAPHQL_PG_CONNECTIONS: '100',
        HASURA_GRAPHQL_LOG_LEVEL: 'debug',
        HASURA_GRAPHQL_JWT_SECRET: JSON.stringify(hasuraJwksEndpointConfig),
        ACTION_BASE_URL: `http://localhost:${backend.containerPort}`,
        REMOTE_SCHEMA_URL: `http://localhost:${backend.containerPort}/graphql/v1`,
      },
      secrets: {
        HASURA_GRAPHQL_METADATA_DATABASE_URL: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
        HASURA_GRAPHQL_DATABASE_URL: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
        HASURA_GRAPHQL_ADMIN_SECRET: EcsSecret.fromSecretsManager(hasuraAdminSecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/healthz || exit 1'],
        // the properties below are optional
        // interval: Duration.minutes(30),
        // retries: 123,
        // startPeriod: Duration.minutes(30),
        // timeout: Duration.minutes(30),
      },
    });

    const ingestWorkerImage = ContainerImage.fromAsset('../ingest-worker', {
      ...commonBuildProps,
      file: 'docker/ingestworker.dockerfile',
    });

    // Update vulnerabilities job
    const updateVulnJob = taskDef.addContainer('UpdateVulnerabilitiesJob', {
      memoryLimitMiB: 8 * 1024,
      cpu: 4 * 1024,
      image: ingestWorkerImage,
      logging: datadogLogDriverForService('lunatrace', 'UpdateVulnerabilitiesJob'),
      environment: { ...baseEnvironmentVars, LUNATRACE_GRAPHQL_SERVER_URL: 'http://localhost:8080/v1/graphql' },
      command: ['sync', '--source', 'ghsa', '--cron', '0 0 * * *'],
      secrets: {
        LUNATRACE_GRAPHQL_SERVER_SECRET: EcsSecret.fromSecretsManager(hasuraAdminSecret),
        LUNATRACE_DB_DSN: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
      },
    });

    updateVulnJob.addContainerDependencies({
      container: hasura,
      condition: ContainerDependencyCondition.HEALTHY,
    });

    const registryProxyImage = ContainerImage.fromAsset('../ingest-worker', {
      ...commonBuildProps,
      file: 'docker/registryproxy.dockerfile',
    });

    const registryPort = 8081;

    // NPM registry proxy
    taskDef.addContainer('NPMRegistryProxy', {
      image: registryProxyImage,
      portMappings: [{ containerPort: registryPort }],
      logging: datadogLogDriverForService('lunatrace', 'NPMRegistryProxy'),
      environment: {
        ...baseEnvironmentVars,
        LUNATRACE_PROXY_PORT: registryPort.toString(10),
        LUNATRACE_PROXY_STAGE: 'release',
      },
      secrets: {
        LUNATRACE_DB_DSN: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
      },
    });

    // NPM replicator
    taskDef.addContainer('NPMReplicator', {
      image: ingestWorkerImage,
      logging: datadogLogDriverForService('lunatrace', 'NPMReplicator'),
      command: ['package', 'replicate', '--resume'],
      environment: {
        ...baseEnvironmentVars,
        LUNATRACE_GRAPHQL_SERVER_URL: 'http://localhost:8080/v1/graphql',
      },
      secrets: {
        LUNATRACE_DB_DSN: EcsSecret.fromSecretsManager(hasuraDatabaseUrlSecret),
        LUNATRACE_GRAPHQL_SERVER_SECRET: EcsSecret.fromSecretsManager(hasuraAdminSecret),
      },
    });

    backend.addContainerDependencies({
      container: oathkeeper,
      condition: ContainerDependencyCondition.HEALTHY,
    });

    hasura.addContainerDependencies(
      {
        container: oathkeeper,
        condition: ContainerDependencyCondition.HEALTHY,
      },
      {
        container: backend,
        condition: ContainerDependencyCondition.HEALTHY,
      }
    );

    frontend.addContainerDependencies({
      container: oathkeeper,
      condition: ContainerDependencyCondition.HEALTHY,
    });

    kratos.addContainerDependencies({
      container: oathkeeper,
      condition: ContainerDependencyCondition.HEALTHY,
    });

    const fargateCluster = new Cluster(this, 'LunaTraceFargateCluster', {
      vpc,
      enableFargateCapacityProviders: true,
    });

    const loadBalancedFargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster: fargateCluster,
      certificate,
      domainZone,
      publicLoadBalancer: true,
      enableExecuteCommand: true,
      assignPublicIp: true,
      redirectHTTP: true,
      sslPolicy: SslPolicy.RECOMMENDED,
      domainName: props.domainName,
      taskDefinition: taskDef,
      securityGroups: [vpcDbSecurityGroup, servicesSecurityGroup],
      circuitBreaker: {
        rollback: true,
      },
      healthCheckGracePeriod: Duration.seconds(5),
      desiredCount: 2,
      deploymentController: {
        type: DeploymentControllerType.ECS,
      },
      cloudMapOptions: {
        name: 'backend',
        cloudMapNamespace: namespace,
        dnsRecordType: DnsRecordType.A,
      },
    });

    loadBalancedFargateService.service.connections.allowFrom(
      servicesSecurityGroup,
      Port.tcp(8080),
      'Allow connections to Hasura from the services security group'
    );

    loadBalancedFargateService.listener.addTargets('LunaTraceApiTargets', {
      priority: 10,
      conditions: [ListenerCondition.pathPatterns(['/health', '/api/*', '/v1/graphql'])],
      protocol: ApplicationProtocol.HTTP,
      port: 4455,
      targets: [
        loadBalancedFargateService.service.loadBalancerTarget({
          containerPort: 4455,
          containerName: oathkeeper.containerName,
        }),
      ],
      healthCheck: {
        enabled: true,
        path: '/api/health',
        port: '4455',
      },
    });

    loadBalancedFargateService.targetGroup.configureHealthCheck({
      enabled: true,
      path: '/health',
    });

    storageStackStage.sbomBucket.grantReadWrite(loadBalancedFargateService.taskDefinition.taskRole);
    storageStackStage.manifestBucket.grantReadWrite(loadBalancedFargateService.taskDefinition.taskRole);
    storageStackStage.processWebhookSqsQueue.grantSendMessages(loadBalancedFargateService.taskDefinition.taskRole);
    storageStackStage.processRepositorySqsQueue.grantSendMessages(loadBalancedFargateService.taskDefinition.taskRole);

    oryConfigBucket.grantReadWrite(loadBalancedFargateService.taskDefinition.taskRole);

    WorkerStack.createWorkerStack(this, {
      env: props.env,
      storageStack: storageStackStage,
      fargateCluster,
      nodeEnvVars,
      nodeSecrets,
      fargateService: loadBalancedFargateService,
      gitHubAppId: props.gitHubAppId,
      publicHasuraServiceUrl,
      datadogApiKeyArn: props.datadogApiKeyArn,
      servicesSecurityGroup,
      vpcDbSecurityGroup,
    });
  }
}
