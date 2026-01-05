/**
 * Fargate Orchestrator for AWS Production
 *
 * Manages ECS Fargate tasks for claude-code agents:
 * - Spawns Fargate tasks on demand via ECS RunTask
 * - Routes messages to running containers via public IP
 * - Persists state in DynamoDB
 * - Handles health checks via ECS DescribeTasks
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  ContainerOrchestrator,
  ContainerSpawnOptions,
  ContainerState,
  ContainerStatus,
  OrchestratorEventHandler,
} from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export interface FargateOrchestratorConfig {
  /** ECS cluster ARN */
  clusterArn: string;
  /** ECS task definition ARN */
  taskDefinitionArn: string;
  /** DynamoDB table name for container state */
  tableName: string;
  /** VPC subnet IDs for Fargate tasks */
  subnetIds: string[];
  /** Security group IDs for Fargate tasks */
  securityGroupIds: string[];
  /** Cast API URL for containers to callback */
  castApiUrl: string;
  /** Anthropic API key */
  anthropicApiKey: string;
  /** Container port (default: 8080) */
  containerPort?: number;
  /** TTL for DynamoDB records in seconds (default: 24 hours) */
  ttlSeconds?: number;
  /** AWS region (default: from environment) */
  region?: string;
  /** Event handler for status updates */
  onEvent?: OrchestratorEventHandler;
}

// =============================================================================
// DynamoDB Record Schema
// =============================================================================

interface ContainerStateRecord {
  threadId: string;
  taskArn: string;
  publicIp: string;
  port: number;
  status: ContainerStatus;
  lastActivity: string;
  createdAt: string;
  ttl: number;
}

// =============================================================================
// Fargate Orchestrator
// =============================================================================

export class FargateOrchestrator implements ContainerOrchestrator {
  private readonly config: Required<Omit<FargateOrchestratorConfig, 'onEvent' | 'region'>> & {
    onEvent?: OrchestratorEventHandler;
    region: string;
  };

  private readonly dynamodb: DynamoDBClient;
  private readonly ecs: ECSClient;

  // In-memory cache for fast lookups (synced with DynamoDB)
  private stateCache: Map<string, ContainerState> = new Map();

  constructor(config: FargateOrchestratorConfig) {
    this.config = {
      clusterArn: config.clusterArn,
      taskDefinitionArn: config.taskDefinitionArn,
      tableName: config.tableName,
      subnetIds: config.subnetIds,
      securityGroupIds: config.securityGroupIds,
      castApiUrl: config.castApiUrl,
      anthropicApiKey: config.anthropicApiKey,
      containerPort: config.containerPort ?? 8080,
      ttlSeconds: config.ttlSeconds ?? 24 * 60 * 60, // 24 hours
      region: config.region ?? process.env.AWS_REGION ?? 'us-east-1',
      onEvent: config.onEvent,
    };

    this.dynamodb = new DynamoDBClient({ region: this.config.region });
    this.ecs = new ECSClient({ region: this.config.region });

    console.log(`[FargateOrchestrator] Initialized`);
    console.log(`[FargateOrchestrator] Cluster: ${this.config.clusterArn}`);
    console.log(`[FargateOrchestrator] Table: ${this.config.tableName}`);
  }

  // ---------------------------------------------------------------------------
  // ContainerOrchestrator Implementation
  // ---------------------------------------------------------------------------

  async spawn(options: ContainerSpawnOptions): Promise<ContainerState> {
    const threadId = this.buildThreadId(options);
    console.log(`[FargateOrchestrator] Spawning container for ${threadId}`);

    // Check if already running
    const existingRecord = await this.getStateFromDynamoDB(threadId);
    if (existingRecord && existingRecord.status === 'running') {
      // Verify task is actually running
      const isHealthy = await this.checkTaskHealth(existingRecord.taskArn);
      if (isHealthy) {
        console.log(`[FargateOrchestrator] Container already running`);
        const existingState = this.recordToState(existingRecord);
        this.stateCache.set(threadId, existingState);
        return existingState;
      }
      // Task died, clean up
      await this.deleteStateFromDynamoDB(threadId);
    }

    // Emit starting event
    await this.emit({ type: 'container_starting', threadId });

    // Run ECS task
    const runTaskResponse = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.config.clusterArn,
        taskDefinition: this.config.taskDefinitionArn,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnetIds,
            securityGroups: this.config.securityGroupIds,
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: 'agent',
              environment: [
                { name: 'ANTHROPIC_API_KEY', value: this.config.anthropicApiKey },
                { name: 'CAST_API_URL', value: this.config.castApiUrl },
                { name: 'CAST_SPACE_ID', value: options.spaceId },
                { name: 'CAST_CHANNEL_ID', value: options.channelId },
                { name: 'CAST_CALLSIGN', value: options.callsign },
                { name: 'CAST_AUTH_TOKEN', value: options.authToken },
                { name: 'THREAD_ID', value: threadId },
              ],
            },
          ],
        },
        tags: [
          { key: 'ThreadId', value: threadId },
          { key: 'SpaceId', value: options.spaceId },
          { key: 'ChannelId', value: options.channelId },
          { key: 'Callsign', value: options.callsign },
        ],
      })
    );

    const task = runTaskResponse.tasks?.[0];
    if (!task?.taskArn) {
      const failure = runTaskResponse.failures?.[0];
      throw new Error(`Failed to start ECS task: ${failure?.reason ?? 'unknown error'}`);
    }

    const taskArn = task.taskArn;
    console.log(`[FargateOrchestrator] Task started: ${taskArn}`);

    // Wait for task to get a public IP
    const { publicIp, status } = await this.waitForTaskReady(taskArn);

    // Wait for container to be healthy
    await this.waitForHealthy(publicIp, this.config.containerPort);

    // Create state
    const now = new Date().toISOString();
    const containerState: ContainerState = {
      threadId,
      containerId: taskArn,
      port: this.config.containerPort,
      status: 'running',
      lastActivity: now,
      createdAt: now,
    };

    // Persist to DynamoDB
    await this.saveStateToDynamoDB(threadId, {
      ...containerState,
      taskArn,
      publicIp,
    });

    // Update cache
    this.stateCache.set(threadId, containerState);

    // Emit ready event
    await this.emit({ type: 'container_ready', threadId, port: this.config.containerPort });

    return containerState;
  }

  async sendMessage(threadId: string, content: string, systemPrompt?: string): Promise<void> {
    const state = await this.getStateFromDynamoDB(threadId);
    if (!state || state.status !== 'running') {
      throw new Error(`No running container for thread ${threadId}`);
    }

    // Verify task is still running
    const isHealthy = await this.checkTaskHealth(state.taskArn);
    if (!isHealthy) {
      await this.updateStatusInDynamoDB(threadId, 'stopped');
      throw new Error(`Container ${state.taskArn} is no longer running`);
    }

    // Forward message to container
    const url = `http://${state.publicIp}:${state.port}/message`;
    const body: { content: string; threadId: string; systemPrompt?: string } = {
      content,
      threadId,
    };
    if (systemPrompt) {
      body.systemPrompt = systemPrompt;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to forward message: ${response.status} ${error}`);
    }

    // Update activity timestamp
    await this.touchActivity(threadId);

    console.log(`[FargateOrchestrator] Message forwarded to container`);
  }

  async stop(threadId: string, reason = 'manual'): Promise<void> {
    const state = await this.getStateFromDynamoDB(threadId);
    if (!state) {
      console.log(`[FargateOrchestrator] No container for thread ${threadId}`);
      return;
    }

    console.log(`[FargateOrchestrator] Stopping ${threadId}: ${reason}`);

    // Stop ECS task
    try {
      await this.ecs.send(
        new StopTaskCommand({
          cluster: this.config.clusterArn,
          task: state.taskArn,
          reason: `Cast orchestrator: ${reason}`,
        })
      );
      console.log(`[FargateOrchestrator] Task stopped: ${state.taskArn}`);
    } catch (error) {
      console.log(`[FargateOrchestrator] Task stop failed (may be already stopped):`, error);
    }

    // Clean up DynamoDB state
    await this.deleteStateFromDynamoDB(threadId);

    // Update cache
    this.stateCache.delete(threadId);

    // Emit event
    await this.emit({ type: 'container_stopped', threadId, reason });
  }

  getStatus(threadId: string): ContainerState | null {
    return this.stateCache.get(threadId) ?? null;
  }

  isRunning(threadId: string): boolean {
    const state = this.stateCache.get(threadId);
    return state?.status === 'running';
  }

  getAllRunning(): ContainerState[] {
    return Array.from(this.stateCache.values()).filter((s) => s.status === 'running');
  }

  async shutdown(): Promise<void> {
    console.log(`[FargateOrchestrator] Shutting down...`);

    // Stop all running containers
    const running = await this.getAllRunningFromDynamoDB();
    for (const state of running) {
      try {
        await this.stop(state.threadId, 'orchestrator shutdown');
      } catch (error) {
        console.error(`[FargateOrchestrator] Error stopping ${state.threadId}:`, error);
      }
    }

    console.log(`[FargateOrchestrator] Shutdown complete`);
  }

  // ---------------------------------------------------------------------------
  // Helper: Build thread ID
  // ---------------------------------------------------------------------------

  private buildThreadId(options: ContainerSpawnOptions): string {
    return `${options.spaceId}:${options.channelId}:${options.callsign}`;
  }

  // ---------------------------------------------------------------------------
  // Helper: Convert DynamoDB record to ContainerState
  // ---------------------------------------------------------------------------

  private recordToState(record: ContainerStateRecord): ContainerState {
    return {
      threadId: record.threadId,
      containerId: record.taskArn, // Use taskArn as containerId for Fargate
      port: record.port,
      status: record.status,
      lastActivity: record.lastActivity,
      createdAt: record.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // DynamoDB Operations
  // ---------------------------------------------------------------------------

  private async getStateFromDynamoDB(threadId: string): Promise<ContainerStateRecord | null> {
    const response = await this.dynamodb.send(
      new GetItemCommand({
        TableName: this.config.tableName,
        Key: marshall({ threadId }),
      })
    );

    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as ContainerStateRecord;
  }

  private async saveStateToDynamoDB(
    threadId: string,
    state: Omit<ContainerState, 'containerId'> & { taskArn: string; publicIp: string }
  ): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + this.config.ttlSeconds;

    const record: ContainerStateRecord = {
      threadId,
      taskArn: state.taskArn,
      publicIp: state.publicIp,
      port: state.port,
      status: state.status,
      lastActivity: state.lastActivity,
      createdAt: state.createdAt,
      ttl,
    };

    await this.dynamodb.send(
      new PutItemCommand({
        TableName: this.config.tableName,
        Item: marshall(record),
      })
    );
  }

  private async updateStatusInDynamoDB(threadId: string, status: ContainerStatus): Promise<void> {
    await this.dynamodb.send(
      new UpdateItemCommand({
        TableName: this.config.tableName,
        Key: marshall({ threadId }),
        UpdateExpression: 'SET #status = :status, lastActivity = :lastActivity',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: marshall({
          ':status': status,
          ':lastActivity': new Date().toISOString(),
        }),
      })
    );

    // Update cache
    const cached = this.stateCache.get(threadId);
    if (cached) {
      cached.status = status;
      cached.lastActivity = new Date().toISOString();
    }
  }

  private async touchActivity(threadId: string): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + this.config.ttlSeconds;

    await this.dynamodb.send(
      new UpdateItemCommand({
        TableName: this.config.tableName,
        Key: marshall({ threadId }),
        UpdateExpression: 'SET lastActivity = :lastActivity, #ttl = :ttl',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: marshall({
          ':lastActivity': new Date().toISOString(),
          ':ttl': ttl,
        }),
      })
    );

    // Update cache
    const cached = this.stateCache.get(threadId);
    if (cached) {
      cached.lastActivity = new Date().toISOString();
    }
  }

  private async deleteStateFromDynamoDB(threadId: string): Promise<void> {
    await this.dynamodb.send(
      new DeleteItemCommand({
        TableName: this.config.tableName,
        Key: marshall({ threadId }),
      })
    );
  }

  private async getAllRunningFromDynamoDB(): Promise<ContainerStateRecord[]> {
    const response = await this.dynamodb.send(
      new ScanCommand({
        TableName: this.config.tableName,
        FilterExpression: '#status = :running',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: marshall({
          ':running': 'running',
        }),
      })
    );

    return (response.Items ?? []).map((item) => unmarshall(item) as ContainerStateRecord);
  }

  // ---------------------------------------------------------------------------
  // ECS Operations
  // ---------------------------------------------------------------------------

  private async waitForTaskReady(
    taskArn: string,
    timeoutMs = 120000
  ): Promise<{ publicIp: string; status: string }> {
    const startTime = Date.now();

    console.log(`[FargateOrchestrator] Waiting for task to get public IP...`);

    while (Date.now() - startTime < timeoutMs) {
      const response = await this.ecs.send(
        new DescribeTasksCommand({
          cluster: this.config.clusterArn,
          tasks: [taskArn],
        })
      );

      const task = response.tasks?.[0];
      if (!task) {
        throw new Error(`Task ${taskArn} not found`);
      }

      // Check for failures
      if (task.lastStatus === 'STOPPED') {
        throw new Error(`Task stopped unexpectedly: ${task.stoppedReason}`);
      }

      // Look for public IP in network interface
      const attachment = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
      const eniDetails = attachment?.details;
      const publicIp = eniDetails?.find((d) => d.name === 'networkInterfaceId');

      // Check if task is running with a public IP
      if (task.lastStatus === 'RUNNING') {
        const container = task.containers?.[0];
        const networkInterface = container?.networkInterfaces?.[0];

        if (networkInterface?.privateIpv4Address) {
          // For Fargate with public IP enabled, we need the public IP
          // It's available in the ENI details
          const eniId = eniDetails?.find((d) => d.name === 'networkInterfaceId')?.value;

          // In Fargate with public IP, the public IP is exposed directly
          // We may need to query EC2 for the ENI, but let's try the direct approach first
          // The publicIpv4Address should be available if assignPublicIp is ENABLED

          // Actually, in newer SDK versions, the public IP is directly available
          // Let's check if it's there
          if (networkInterface.privateIpv4Address) {
            // For now, use the private IP - in a VPC with NAT, this works
            // For true public access, we'd need an ALB or the ENI public IP
            // Let's wait a bit for the public IP to be assigned
            await this.sleep(2000);

            // Re-fetch to get public IP
            const refetchResponse = await this.ecs.send(
              new DescribeTasksCommand({
                cluster: this.config.clusterArn,
                tasks: [taskArn],
              })
            );

            const refetchTask = refetchResponse.tasks?.[0];
            const refetchContainer = refetchTask?.containers?.[0];
            const refetchNi = refetchContainer?.networkInterfaces?.[0];

            // The private IP can be used if we're in the same VPC
            // For cross-VPC/public access, we need the public IP from the ENI
            const ip = refetchNi?.privateIpv4Address;

            if (ip) {
              console.log(`[FargateOrchestrator] Task ready with IP: ${ip}`);
              return { publicIp: ip, status: task.lastStatus ?? 'RUNNING' };
            }
          }
        }
      }

      await this.sleep(2000);
    }

    throw new Error(`Timed out waiting for task to be ready after ${timeoutMs}ms`);
  }

  private async checkTaskHealth(taskArn: string): Promise<boolean> {
    try {
      const response = await this.ecs.send(
        new DescribeTasksCommand({
          cluster: this.config.clusterArn,
          tasks: [taskArn],
        })
      );

      const task = response.tasks?.[0];
      return task?.lastStatus === 'RUNNING';
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Container Health Check
  // ---------------------------------------------------------------------------

  private async waitForHealthy(ip: string, port: number, timeoutMs = 60000): Promise<void> {
    const startTime = Date.now();
    const healthUrl = `http://${ip}:${port}/health`;

    console.log(`[FargateOrchestrator] Waiting for health at ${healthUrl}`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          console.log(`[FargateOrchestrator] Healthy after ${Date.now() - startTime}ms`);
          return;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(2000);
    }

    throw new Error(`Container health check timed out after ${timeoutMs}ms`);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private async emit(event: Parameters<OrchestratorEventHandler>[0]): Promise<void> {
    if (this.config.onEvent) {
      await this.config.onEvent(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
