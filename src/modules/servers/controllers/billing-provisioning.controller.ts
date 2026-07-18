import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import * as crypto from 'crypto';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { EggsService } from '../../eggs/eggs.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { UsersService } from '../../users/users.service';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { cpuLimitPercentage, diskLimitBytes, memoryBytes, normalizeVariables } from '../utils/server-controller.helpers';
import { ServerPlacementService } from '../services/server-placement.service';
import { ServerPlansService } from '../services/server-plans.service';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerCreationService } from '../services/server-creation.service';
import { AgentsService } from '../../agents/agents.service';
import { ServerDatabasesService } from '../services/server-databases.service';
import { Public } from '../../security/public.decorator';
import { ApiConfigService } from '../../../common/config/config.service';
import { BillingWebhookDto, ServerPlanDto } from '../dto/billing-provisioning.dto';

type BillingProvider = 'generic' | 'whmcs' | 'paymenter';

const AUTO_NODE_ID = 'auto-least-memory';
const BILLING_PROTECTED_VARIABLES = new Set([
  'MEMORY', 'SERVER_MEMORY', 'SERVER_DISK', 'SERVER_CPU', 'SERVER_CPU_CORES',
  'CPU_LIMIT', 'CPU_CORES', 'SERVER_IP', 'STARTUP', 'DOCKER_IMAGE', 'SERVER_ID',
]);

@Controller()
export class BillingProvisioningController {
  constructor(
    private readonly client: AgentClientService,
    private readonly eggs: EggsService,
    private readonly placement: ServerPlacementService,
    private readonly plans: ServerPlansService,
    private readonly registry: ServerRegistryService,
    private readonly creation: ServerCreationService,
    private readonly agents: AgentsService,
    private readonly users: UsersService,
    private readonly webhooks: WebhooksService,
    private readonly databases: ServerDatabasesService,
    private readonly config: ApiConfigService
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('server-plans')
  @Roles('admin')
  listPlans() {
    return this.plans.list();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('server-plans')
  @Roles('admin')
  createPlan(@Body() body: ServerPlanDto) {
    try {
      const eggId = body?.eggId || body?.egg_id;
      const location = String(body?.location || '').trim().toLocaleLowerCase();
      const nodeId = String(body?.nodeId || body?.node_id || AUTO_NODE_ID);
      this.validatePlanTarget(location, nodeId);
      return this.plans.create({
        ...body,
        location,
        nodeId,
        allowedEggIds: this.eggs.validateIds(body?.allowedEggIds ?? body?.allowed_egg_ids, eggId)
      });
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch('server-plans/:id')
  @Roles('admin')
  updatePlan(@Param('id') id: string, @Body() body: ServerPlanDto) {
    try {
      const existing = this.plans.get(id);
      if (!existing) throw new Error('plan not found');
      const eggId = body?.eggId || body?.egg_id || existing.eggId;
      const location = body?.location === undefined ? existing.location : String(body.location || '').trim().toLocaleLowerCase();
      const nodeId = String(body?.nodeId || body?.node_id || existing.nodeId || AUTO_NODE_ID);
      this.validatePlanTarget(location, nodeId);
      return this.plans.update(id, {
        ...body,
        location,
        nodeId,
        allowedEggIds: this.eggs.validateIds(body?.allowedEggIds ?? body?.allowed_egg_ids ?? existing.allowedEggIds, eggId)
      });
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete('server-plans/:id')
  @Roles('admin')
  deletePlan(@Param('id') id: string) {
    try {
      return this.plans.remove(id);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }

  @Public()
  @Post('billing/provision')
  handleGeneric(@Body() body: BillingWebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.handleBilling('generic', body, headers);
  }

  @Public()
  @Post('billing/whmcs')
  handleWhmcs(@Body() body: BillingWebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.handleBilling('whmcs', body, headers);
  }

  @Public()
  @Post('billing/paymenter')
  handlePaymenter(@Body() body: BillingWebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.handleBilling('paymenter', body, headers);
  }

  @Public()
  @Post('webhooks/whmcs')
  handleLegacyWhmcs(@Body() body: BillingWebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.handleBilling('whmcs', body, headers);
  }

  @Public()
  @Post('billing/freeze')
  freezeWebhook(@Body() body: BillingWebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    this.requireSecret(headers);
    return this.freeze('generic', body);
  }

  @Public()
  @Post('billing/unfreeze')
  unfreezeWebhook(@Body() body: BillingWebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    this.requireSecret(headers);
    return this.unfreeze('generic', body);
  }

  private async handleBilling(provider: BillingProvider, body: any, headers: Record<string, string | string[] | undefined>) {
    this.requireSecret(headers);

    const action = this.action(body);
    if (action === 'provision') return this.provision(provider, body);
    if (action === 'remove') return this.remove(provider, body);
    if (action === 'freeze') return this.freeze(provider, body);
    if (action === 'unfreeze') return this.unfreeze(provider, body);

    throw new HttpException('unsupported billing action', HttpStatus.BAD_REQUEST);
  }

  private async freeze(provider: BillingProvider, body: any) {
    const serverId = this.serverId(body, false);
    if (!serverId) throw new HttpException('serverId or serviceId is required', HttpStatus.BAD_REQUEST);
    const server = await this.registry.get(serverId);
    if (!server) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    if (this.registry.isFrozen(server)) return { action: 'freeze', provider, success: true, idempotentReplay: true, serverId };

    const variables = {
      ...(server.variables || {}),
      AGAPORNIS_FROZEN: 'true',
      AGAPORNIS_FREEZE_REASON: String(this.value(body, 'reason', 'message') || 'Frozen by administrator'),
      AGAPORNIS_PRE_FREEZE_STATUS: server.status
    };
    await this.registry.updateSettings(serverId, { variables });
    await this.registry.setStatus(serverId, 'frozen');
    let stopWarning: string | undefined;
    try {
      await this.client.stopServer(server.nodeId, serverId);
      await this.databases.powerAllForServer(serverId, 'stop');
    } catch (error: any) {
      stopWarning = error?.message || 'server was locked but could not be stopped';
    }
    await this.webhooks.dispatch('billing.server.frozen', { provider, serverId, nodeId: server.nodeId, reason: variables.AGAPORNIS_FREEZE_REASON }, undefined, 'admin');
    return { action: 'freeze', provider, success: true, serverId, stopWarning };
  }

  private async unfreeze(provider: BillingProvider, body: any) {
    const serverId = this.serverId(body, false);
    if (!serverId) throw new HttpException('serverId or serviceId is required', HttpStatus.BAD_REQUEST);
    const server = await this.registry.get(serverId);
    if (!server) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    if (!this.registry.isFrozen(server)) return { action: 'unfreeze', provider, success: true, idempotentReplay: true, serverId };
    const variables = { ...(server.variables || {}) };
    delete variables.AGAPORNIS_FROZEN;
    delete variables.AGAPORNIS_FREEZE_REASON;
    delete variables.AGAPORNIS_PRE_FREEZE_STATUS;
    await this.registry.updateSettings(serverId, { variables });
    await this.registry.setStatus(serverId, 'stopped');
    await this.webhooks.dispatch('billing.server.unfrozen', { provider, serverId, nodeId: server.nodeId }, undefined, 'admin');
    return { action: 'unfreeze', provider, success: true, serverId, status: 'stopped' };
  }

  private async provision(provider: BillingProvider, body: any) {
    const plan = this.resolvePlan(body);
    const customer = this.customer(body);
    const userResult = await this.users.provisionUser({ email: customer.email, name: customer.name });
    const user = userResult.user as any;
    const serverId = this.serverId(body);
    const nodeId = await this.nodeId(plan);
    const node = this.agents.get(nodeId);
    if (!node?.portRangeStart || !node?.portRangeEnd) {
      throw new HttpException(`node "${nodeId}" does not have a game port range configured`, HttpStatus.CONFLICT);
    }
    const requestBody = {
      ...body,
      eggId: plan.eggId,
      eggChangeAllowed: plan.eggChangeAllowed,
      allowedEggIds: plan.allowedEggIds,
      nodeId,
      serverId,
      userId: user.id,
      name: this.serverName(body) || `${plan.name} ${serverId}`,
      memoryMb: plan.memoryMb,
      cpuLimitPercentage: plan.cpuLimitPercentage,
      cpuPinning: Boolean(plan.cpuPinnedThreads),
      cpuPinnedThreads: plan.cpuPinnedThreads,
      swapMemoryMb: plan.swapMemoryMb,
      swapMemoryStorage: plan.swapMemoryStorage,
      diskMb: plan.diskMb,
      hostPort: 0,
      // A matched plan is the authority for images and resource controls.
      // Legacy payloads still work because resolvePlan copies their values
      // into the synthetic plan before this point.
      dockerImage: plan.dockerImage,
      variables: {
        ...plan.variables,
        ...this.variables(body),
        AGAPORNIS_CPU_PINNING: plan.cpuPinnedThreads ? 'true' : 'false',
        AGAPORNIS_CPU_PINNED_THREADS: plan.cpuPinnedThreads || '',
        AGAPORNIS_SWAP_MEMORY_MB: String(plan.swapMemoryMb || 0),
        AGAPORNIS_SWAP_MEMORY_STORAGE: plan.swapMemoryStorage || 'general',
      }
    };

    const reservation = await this.registry.reserveRandomPort({
      id: serverId,
      nodeId,
      name: requestBody.name,
      eggId: plan.eggId,
      eggChangeAllowed: plan.eggChangeAllowed,
      allowedEggIds: plan.allowedEggIds,
      ownerUserId: user.id,
      status: 'provisioning',
      memoryBytes: memoryBytes(requestBody),
      cpuLimitPercentage: cpuLimitPercentage(requestBody),
      diskLimitBytes: diskLimitBytes(requestBody),
      databasesEnabled: Boolean(plan.databasesEnabled),
      databaseLimit: Number(plan.databaseLimit || 0),
      databaseMemoryBytes: Number(plan.databaseMemoryMb || 512) * 1024 * 1024,
      databaseDiskLimitBytes: Number(plan.databaseDiskMb || 1024) * 1024 * 1024,
      databaseCpuLimitPercentage: Number(plan.databaseCpuLimitPercentage || 50),
      databaseCpuCores: undefined,
      databaseDockerImage: String(plan.databaseDockerImage || 'mariadb:latest'),
      allowedDatabaseTypes: plan.allowedDatabaseTypes,
      databasePortRangeMode: plan.databasePortRangeMode,
      databasePortRangeStart: Number(plan.databasePortRangeStart || 33060),
      databasePortRangeEnd: Number(plan.databasePortRangeEnd || 33160),
      backupLimit: Number(plan.backupLimit ?? 0),
      variables: requestBody.variables,
      createdAt: new Date().toISOString()
    }, node.portRangeStart, node.portRangeEnd);
    if (reservation.replay) {
      return { action: 'provision', provider, success: true, idempotentReplay: true, planId: plan.id, serverId, nodeId: reservation.record.nodeId, location: this.agents.get(reservation.record.nodeId)?.location || '', user, userCreated: false };
    }
    const portCount = Math.max(1, Math.min(32, Math.floor(Number(plan.portCount || 1))));
    let allocatedRecord;
    try {
      allocatedRecord = await this.registry.assignPortAllocations(serverId, portCount, node.portRangeStart, node.portRangeEnd);
    } catch (error) {
      await this.registry.releaseProvisioning(serverId);
      throw error;
    }
    const allocatedPort = allocatedRecord.assignedHostPort!;
    requestBody.hostPort = allocatedPort;
    requestBody.serverIp = this.agents.connectionHost(nodeId);
    requestBody.variables = { ...requestBody.variables, ...(allocatedRecord.variables || {}) };
    requestBody.portMappings = this.registry.portMappings(allocatedRecord.variables).map(mapping => ({
      variable: mapping.variable,
      internal_port: `${mapping.internalPort}/${mapping.protocol || 'tcp'}`,
      host_port: mapping.hostPort
    }));

    const resolved = this.eggs.resolveServer(plan.eggId, requestBody);

    // Removed issueShortLivedJwt - mTLS handles auth automatically via AgentClientService
    let response: any;
    try {
      response = await this.creation.create(nodeId, resolved);
      if (response?.success === false) throw new HttpException(response?.error_message || response?.errorMessage || 'agent rejected server create', HttpStatus.BAD_GATEWAY);
      const finalPort = response?.assigned_host_port || response?.assignedHostPort || response?.data?.assigned_host_port || response?.data?.assignedHostPort || allocatedPort;
      await this.registry.finalizeProvisioning(serverId, finalPort);
    } catch (error) {
      await this.client.deleteServer(nodeId, serverId).catch(() => undefined);
      await this.registry.releaseProvisioning(serverId);
      throw error;
    }

    await this.webhooks.dispatch('billing.server.provisioned', {
      provider,
      planId: plan.id,
      planName: plan.name,
      nodeId,
      location: String(node?.location || '').trim().toLocaleLowerCase(),
      serverId,
      serverName: requestBody.name,
      userId: user.id,
      email: customer.email,
      eggId: plan.eggId,
      userCreated: Boolean(userResult.created)
    }, undefined, 'admin');

    return {
      action: 'provision',
      provider,
      success: true,
      planId: plan.id,
      serverId,
      nodeId,
      location: String(node.location || '').trim().toLocaleLowerCase(),
      user,
      userCreated: Boolean(userResult.created),
      temporaryPassword: userResult.temporaryPassword
    };
  }

  private async remove(provider: BillingProvider, body: any) {
    const serverId = this.serverId(body, false);
    if (!serverId) throw new HttpException('serverId or serviceId is required', HttpStatus.BAD_REQUEST);

    const claim = await this.registry.claimDeletion(serverId);
    if (!claim) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    if (claim.replay) return { action: 'remove', provider, success: true, idempotentReplay: true, serverId };
    const server = claim.record;

    // Removed issueShortLivedJwt - mTLS handles auth automatically via AgentClientService
    try {
      const response: any = await this.client.deleteServer(server.nodeId, serverId);
      if (response?.success === false) {
        throw new HttpException(response?.error_message || response?.errorMessage || 'agent rejected server delete', HttpStatus.BAD_GATEWAY);
      }
      await this.registry.remove(serverId);
    } catch (error) {
      await this.registry.restoreDeletion(serverId, claim.previousStatus);
      throw error;
    }
    await this.webhooks.dispatch('billing.server.removed', {
      provider,
      nodeId: server.nodeId,
      location: String(this.agents.get(server.nodeId)?.location || '').trim().toLocaleLowerCase(),
      serverId,
      serverName: server.name,
      userId: server.ownerUserId,
      status: 'deleted'
    }, undefined, 'admin');

    return { action: 'remove', provider, success: true, serverId };
  }

  private resolvePlan(body: any) {
    const explicit = this.value(body, 'planId', 'plan_id', 'plan', 'planKey', 'plan_key');
    const product = this.value(body, 'productId', 'product_id', 'packageId', 'package_id', 'package', 'pid', 'relid');
    const plan = this.plans.findByExternalId(String(explicit || product || ''));
    if (plan) return plan;

    const legacyEggId = this.value(body, 'eggId', 'egg_id', 'egg') || this.config.get('WHMCS_DEFAULT_EGG_ID');
    if (legacyEggId) {
      return {
        id: 'legacy-payload',
        name: 'Legacy payload',
        enabled: true,
        externalIds: [],
        eggId: String(legacyEggId),
        eggChangeAllowed: false,
        allowedEggIds: [String(legacyEggId)],
        location: String(this.value(body, 'location', 'region') || this.config.get('WHMCS_DEFAULT_LOCATION')).trim().toLocaleLowerCase(),
        nodeId: String(this.value(body, 'nodeId', 'node_id', 'node') || this.config.get('WHMCS_DEFAULT_NODE_ID') || AUTO_NODE_ID),
        memoryMb: Number(this.value(body, 'memoryMb', 'memory_mb') || 1024),
        diskMb: Number(this.value(body, 'diskMb', 'disk_mb') || 10240),
        cpuLimitPercentage: Number(this.value(body, 'cpuLimitPercentage', 'cpu_limit_percentage') || 100),
        cpuPinnedThreads: String(this.value(body, 'cpuPinnedThreads', 'cpu_pinned_threads') || ''),
        swapMemoryMb: Number(this.value(body, 'swapMemoryMb', 'swap_memory_mb') || 0),
        swapMemoryStorage: String(this.value(body, 'swapMemoryStorage', 'swap_memory_storage') || 'general') === 'server' ? 'server' : 'general',
        portCount: Number(this.value(body, 'portCount', 'port_count', 'ports') || 1),
        databasesEnabled: Boolean(this.value(body, 'databasesEnabled', 'databases_enabled')),
        databaseLimit: Number(this.value(body, 'databaseLimit', 'database_limit') || 0),
        databaseMemoryMb: Number(this.value(body, 'databaseMemoryMb', 'database_memory_mb') || 512),
        databaseDiskMb: Number(this.value(body, 'databaseDiskMb', 'database_disk_mb') || 1024),
        databaseCpuLimitPercentage: Number(this.value(body, 'databaseCpuLimitPercentage', 'database_cpu_limit_percentage') || 50),
        databaseCpuCores: undefined,
        databaseDockerImage: String(this.value(body, 'databaseDockerImage', 'database_docker_image') || 'mariadb:latest'),
        allowedDatabaseTypes: this.value(body, 'allowedDatabaseTypes', 'allowed_database_types') || ['mariadb'],
        databasePortRangeMode: this.value(body, 'databasePortRangeMode', 'database_port_range_mode') || 'game',
        databasePortRangeStart: Number(this.value(body, 'databasePortRangeStart', 'database_port_range_start') || 33060),
        databasePortRangeEnd: Number(this.value(body, 'databasePortRangeEnd', 'database_port_range_end') || 33160),
        backupLimit: Number(this.value(body, 'backupLimit', 'backup_limit') || 0),
        dockerImage: this.value(body, 'dockerImage', 'docker_image'),
        variables: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }

    throw new HttpException('no matching server plan found for this product', HttpStatus.BAD_REQUEST);
  }

  private async nodeId(plan: any) {
    const requestedNodeId = plan.nodeId && plan.nodeId !== AUTO_NODE_ID ? String(plan.nodeId) : undefined;
    const placement = await this.placement.selectLeastMemoryUtilized(
      Number(plan.memoryMb || 0) * 1024 * 1024,
      String(plan.location || '').trim().toLocaleLowerCase() || undefined,
      requestedNodeId,
      (Number(plan.diskMb || 0) + (plan.swapMemoryStorage === 'general' ? Number(plan.swapMemoryMb || 0) : 0)) * 1024 * 1024
    );
    return placement.nodeId;
  }

  private validatePlanTarget(location: string, nodeId: string) {
    if (!nodeId || nodeId === AUTO_NODE_ID) return;
    const node = this.agents.get(nodeId);
    if (!node) throw new Error(`node "${nodeId}" is not registered`);
    const nodeLocation = String(node.location || '').trim().toLocaleLowerCase();
    if (location && nodeLocation !== location) {
      throw new Error(`node "${nodeId}" is not in location "${location}"`);
    }
  }

  private requireSecret(headers: Record<string, string | string[] | undefined>) {
    const expected = this.config.get('BILLING_WEBHOOK_SECRET') || this.config.get('WHMCS_WEBHOOK_SECRET');
    if (!expected) {
      throw new HttpException('BILLING_WEBHOOK_SECRET is not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const provided = this.header(headers, 'x-agapornis-secret') || this.header(headers, 'x-billing-secret') || this.header(headers, 'x-whmcs-secret') || this.header(headers, 'x-paymenter-secret');
    if (!provided || !this.sameSecret(expected, provided)) {
      throw new HttpException('invalid billing webhook secret', HttpStatus.UNAUTHORIZED);
    }
  }

  private sameSecret(expected: string, provided: string) {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private action(body: any) {
    const raw = String(this.value(body, 'action', 'event', 'type', 'hook', 'messagename', 'status') || '').toLowerCase();
    const compact = raw.replace(/[^a-z0-9]/g, '');
    if ([
      'buy',
      'create',
      'provision',
      'activate',
      'active',
      'paid',
      'orderpaid',
      'ordercreated',
      'invoicepaid',
      'shoppingcartcheckoutcomplete',
      'acceptorder',
      'aftermodulecreate',
      'servicecreated',
      'serviceactivated'
    ].includes(compact)) return 'provision';
    if (['suspend', 'suspended', 'aftersuspend', 'aftermodulesuspend', 'servicesuspended'].includes(compact)) return 'freeze';
    if (['unsuspend', 'unfreeze', 'reactivate', 'afterunsuspend', 'aftermoduleunsuspend', 'serviceunsuspended'].includes(compact)) return 'unfreeze';
    if (['delete', 'remove', 'terminate', 'terminated', 'cancel', 'cancelled', 'aftermoduleterminate', 'servicedeleted'].includes(compact)) return 'remove';
    return raw;
  }

  private customer(body: any) {
    const email = this.value(body, 'email', 'clientEmail', 'client_email', 'userEmail', 'user_email', 'customerEmail', 'customer_email');
    if (!email) throw new HttpException('customer email is required', HttpStatus.BAD_REQUEST);

    const name = this.value(body, 'name', 'clientName', 'client_name', 'customerName', 'customer_name') || [
      this.value(body, 'firstName', 'firstname', 'first_name'),
      this.value(body, 'lastName', 'lastname', 'last_name')
    ].filter(Boolean).join(' ');

    const normalizedEmail = String(email).trim().toLowerCase();
    if (normalizedEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new HttpException('customer email is invalid', HttpStatus.BAD_REQUEST);
    }
    const normalizedName = String(name || normalizedEmail).trim();
    if (!normalizedName || normalizedName.length > 160 || /[\0-\x1f\x7f]/.test(normalizedName)) {
      throw new HttpException('customer name is invalid', HttpStatus.BAD_REQUEST);
    }
    return { email: normalizedEmail, name: normalizedName };
  }

  private serverName(body: any) {
    const value = this.value(body, 'serverName', 'server_name', 'serviceName', 'service_name', 'name');
    if (value === undefined) return undefined;
    const name = String(value).trim();
    if (!name || name.length > 160 || /[\0-\x1f\x7f]/.test(name)) {
      throw new HttpException('server name is invalid', HttpStatus.BAD_REQUEST);
    }
    return name;
  }

  private serverId(body: any, generate = true) {
    const explicit = this.value(body, 'serverId', 'server_id');
    if (explicit) return this.validServerId(explicit);

    const serviceId = this.value(body, 'serviceId', 'service_id', 'relid', 'hostingId', 'hosting_id', 'serviceid', 'orderId', 'order_id', 'invoiceId', 'invoice_id');
    if (serviceId) {
      const raw = String(serviceId).trim();
      if (/^[A-Za-z0-9_-]{1,120}$/.test(raw)) return `srv-${raw}`;
      const prefix = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'external';
      const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
      return `srv-${prefix}-${digest}`;
    }
    return generate ? `srv-${crypto.randomUUID().slice(0, 8)}` : '';
  }

  private validServerId(value: unknown) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new HttpException('serverId is invalid', HttpStatus.BAD_REQUEST);
    }
    return id;
  }

  private value(body: any, ...keys: string[]) {
    const queue = [body, body?.data, body?.params, body?.client, body?.customer, body?.user, body?.clientdetails, body?.clientsdetails, body?.service, body?.product, body?.package, body?.order];
    for (const key of keys) {
      for (const source of queue) {
        const value = this.lookup(source, key);
        if (value !== undefined && value !== null && value !== '') return value;
      }
      const custom = this.lookupOption(body?.customfields, key) ?? this.lookupOption(body?.configoptions, key) ?? this.lookupOption(body?.customFields, key);
      if (custom !== undefined && custom !== null && custom !== '') return custom;
    }
    return undefined;
  }

  private variables(body: any) {
    const variables = normalizeVariables({
      ...this.optionRecord(body?.customfields),
      ...this.optionRecord(body?.customFields),
      ...this.optionRecord(body?.configoptions),
      ...this.optionRecord(body?.configOptions),
      ...(body?.variables || {}),
      ...(body?.env || {})
    });
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(variables)) {
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) continue;
      if (key.startsWith('AGAPORNIS_') || BILLING_PROTECTED_VARIABLES.has(key)) continue;
      if (value.length > 8192 || /\0/.test(value)) {
        throw new HttpException(`billing variable '${key}' is invalid`, HttpStatus.BAD_REQUEST);
      }
      sanitized[key] = value;
    }
    return sanitized;
  }

  private lookup(source: any, key: string) {
    if (!source || typeof source !== 'object') return undefined;
    if (source[key] !== undefined) return source[key];
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const found = Object.keys(source).find(candidate => candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
    return found ? source[found] : undefined;
  }

  private lookupOption(source: any, key: string) {
    const record = this.optionRecord(source);
    return this.lookup(record, key);
  }

  private optionRecord(source: any) {
    if (!source) return {};
    if (!Array.isArray(source) && typeof source === 'object') return source;
    if (!Array.isArray(source)) return {};

    return source.reduce<Record<string, any>>((acc, item) => {
      const name = item?.name || item?.fieldname || item?.option || item?.key;
      if (!name) return acc;
      const key = String(name);
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return acc;
      acc[key] = item?.value ?? item?.fieldvalue ?? item?.selected ?? '';
      return acc;
    }, Object.create(null));
  }

  private header(headers: Record<string, string | string[] | undefined>, key: string) {
    const value = headers[key] || headers[key.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
}
