const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { ServerRouteSupportService } = require('../src/modules/servers/services/server-route-support.service.ts');
const { ServerRegistryService } = require('../src/modules/servers/services/server-registry.service.ts');
const { ServerDatabasesService } = require('../src/modules/servers/services/server-databases.service.ts');
const { ServerFilesController } = require('../src/modules/servers/controllers/server-files.controller.ts');
const { ServersController } = require('../src/modules/servers/controllers/servers.controller.ts');
const { createServerRequest } = require('../src/modules/servers/utils/server-controller.helpers.ts');
const { resolveServer } = require('../src/modules/eggs/egg-resolver.ts');

async function main() {
  let reserved;
  const registry = {
    reserve: async record => {
      reserved = record;
      return { record, replay: false };
    }
  };
  const support = new ServerRouteSupportService(registry, {}, {});
  const existing = {
    SERVER_ID: 'server-1',
    SERVER_PORT: '25565',
    SERVER_MEMORY: '2048',
    SERVER_IP: 'node.example.test',
    PUBLIC_SETTING: 'old',
    INTERNAL_SECRET: 'keep'
  };
  const editable = new Set(['PUBLIC_SETTING']);

  const userUpdate = support.applyVariableUpdate(
    { PUBLIC_SETTING: 'new' },
    existing,
    editable,
    { role: 'user' }
  );
  assert.equal(userUpdate.PUBLIC_SETTING, 'new');
  assert.equal(userUpdate.INTERNAL_SECRET, 'keep');
  assert.equal(userUpdate.SERVER_ID, 'server-1');

  assert.throws(
    () => support.applyVariableUpdate({ INTERNAL_SECRET: 'changed' }, existing, editable, { role: 'user' }),
    /not user-editable/
  );
  assert.throws(
    () => support.applyVariableUpdate({ SERVER_ID: 'changed' }, existing, editable, { role: 'admin' }),
    /managed by the panel/
  );
  const protectedIpUpdate = support.applyVariableUpdate({ SERVER_IP: 'spoofed.example.test' }, existing, editable, { role: 'admin' });
  assert.equal(protectedIpUpdate.SERVER_IP, 'node.example.test', 'SERVER_IP must remain panel-managed');

  const adminUpdate = support.applyVariableUpdate({ PUBLIC_SETTING: 'admin' }, existing, editable, { role: 'admin' });
  assert.equal(adminUpdate.SERVER_ID, 'server-1');
  assert.equal(adminUpdate.SERVER_MEMORY, '2048', 'hidden resource variables must survive normal variable saves');
  const portMetadata = JSON.stringify([{ variable: 'SERVER_PORT', internalPort: 25565, hostPort: 30001, protocol: 'tcp' }]);
  const adminPortUpdate = support.applyVariableUpdate(
    { SERVER_PORT: '25566' },
    { ...existing, AGAPORNIS_PORT_MAPPINGS: portMetadata },
    editable,
    { role: 'admin' }
  );
  assert.equal(JSON.parse(adminPortUpdate.AGAPORNIS_PORT_MAPPINGS)[0].internalPort, 25566);
  assert.throws(
    () => support.applyVariableUpdate({ SERVER_ID: 'owner-change' }, existing, editable, { role: 'owner' }),
    /managed by the panel/
  );
  const ownerUpdate = support.applyVariableUpdate({ PUBLIC_SETTING: 'owner' }, existing, editable, { role: 'owner' });
  assert.equal(ownerUpdate.SERVER_ID, 'server-1');
  assert.equal(ownerUpdate.SERVER_MEMORY, '2048');
  const percentageResourcePatch = support.resourcePatch({ memoryMb: 2048, diskMb: 4096, cpuLimitPercentage: 175, cpuPinnedThreads: '2-4,6', swapMemoryMb: 512, swapMemoryStorage: 'server' });
  assert.equal(percentageResourcePatch.memoryBytes, 2048 * 1024 * 1024);
  assert.equal(percentageResourcePatch.diskLimitBytes, 4096 * 1024 * 1024);
  assert.equal(percentageResourcePatch.cpuLimitPercentage, 175);
  assert.equal(percentageResourcePatch.cpuPinnedThreads, '2-4,6');
  assert.equal(percentageResourcePatch.swapMemoryBytes, 512 * 1024 * 1024);
  assert.equal(percentageResourcePatch.swapMemoryStorage, 'server');
  const resourceVariables = support.mergeResourceVariables({ SERVER_CPU_CORES: '2', CPU_CORES: '2' }, percentageResourcePatch);
  assert.equal(resourceVariables.SERVER_CPU, '175');
  assert.equal(resourceVariables.SERVER_CPU_CORES, undefined);
  assert.equal(resourceVariables.CPU_CORES, undefined);
  assert.equal(resourceVariables.AGAPORNIS_CPU_PINNING, 'true');
  assert.equal(resourceVariables.AGAPORNIS_CPU_PINNED_THREADS, '2-4,6');
  assert.equal(resourceVariables.AGAPORNIS_SWAP_MEMORY_MB, '512');
  assert.equal(resourceVariables.AGAPORNIS_SWAP_MEMORY_STORAGE, 'server');

  const resolvedStartup = resolveServer({
    id: 'startup-variable-test',
    name: 'Startup variable test',
    description: '',
    nestId: 'test',
    images: ['example/server:latest'],
    environment: {},
    variables: [],
    startup: 'run --memory {{SERVER_MEMORY}} --ip {{SERVER_IP}} --port {{SERVER_PORT}} --custom {{CUSTOM_CREATED}}',
    stopCommand: '',
    startupDone: '',
    configFiles: {}
  }, {
    serverId: 'server-1',
    memoryMb: 4096,
    serverIp: 'node.example.test',
    serverPort: 25565,
    variables: { CUSTOM_CREATED: 'custom-value', SERVER_IP: 'spoofed.example.test' }
  });
  assert.equal(
    resolvedStartup.startup_command,
    'run --memory 4096 --ip node.example.test --port 25565 --custom custom-value',
    'startup must resolve resource, node, port, and custom server variables'
  );

  const createRequest = createServerRequest({ serverId: 'create-resource-test', cpuLimitPercentage: 250, cpuCores: 8, cpuPinnedThreads: '0,2-3', swapMemoryMb: 1024, swapMemoryStorage: 'general' });
  assert.equal(createRequest.cpu_limit_percentage, 250, 'create must preserve percentage semantics');
  assert.equal(createRequest.cpu_cores, 0, 'create must ignore the legacy core override');
  assert.equal(createRequest.cpu_pinning, true);
  assert.equal(createRequest.cpu_pinned_threads, '0,2-3');
  assert.equal(createRequest.swap_memory_bytes, 1024 * 1024 * 1024);
  assert.equal(createRequest.swap_memory_storage, 'general');
  assert.throws(() => support.resourcePatch({ cpuPinnedThreads: '4-2' }), /invalid pinned CPU thread range/);

  const installVariables = support.filterEggInstallVariables(
    { PUBLIC_SETTING: 'install', SERVER_PORT: '25565' },
    existing,
    editable,
    { role: 'user' }
  );
  assert.deepEqual(installVariables, { PUBLIC_SETTING: 'install' });

  await support.reserveServer('node-1', {
    serverId: 'server-1',
    databasesEnabled: true,
    databaseLimit: 3,
    databaseMemoryMb: 768,
    databaseDiskMb: 2048,
    backupLimit: 5
  }, { id: 'owner-1' });
  assert.equal(reserved.databasesEnabled, true);
  assert.equal(reserved.databaseLimit, 3);
  assert.equal(reserved.databaseMemoryBytes, 768 * 1024 * 1024);
  assert.equal(reserved.databaseDiskLimitBytes, 2048 * 1024 * 1024);
  assert.equal(reserved.backupLimit, 5);

  const accessRegistry = Object.create(ServerRegistryService.prototype);
  const sharedServer = {
    id: 'shared-1',
    ownerUserId: 'owner-1',
    collaborators: [
      { userId: 'reader-1', permission: 'read_only' },
      { userId: 'operator-1', permission: 'operator' },
      { userId: 'console-1', permission: 'custom', permissions: ['console.view', 'console.send'] }
    ]
  };
  assert.equal(accessRegistry.canAccess(sharedServer, { id: 'reader-1', role: 'user' }), true);
  assert.equal(accessRegistry.canWrite(sharedServer, { id: 'reader-1', role: 'user' }), false);
  assert.equal(accessRegistry.canWrite(sharedServer, { id: 'operator-1', role: 'user' }), true);
  assert.equal(accessRegistry.canWrite(sharedServer, { id: 'owner-1', role: 'user' }), true);
  assert.equal(accessRegistry.canWrite(sharedServer, { id: 'support-1', role: 'support' }), false);
  assert.equal(accessRegistry.canPerform(sharedServer, { id: 'console-1', role: 'user' }, 'console.view'), true);
  assert.equal(accessRegistry.canPerform(sharedServer, { id: 'console-1', role: 'user' }, 'files.view'), false);
  assert.equal(accessRegistry.canPerform(sharedServer, { id: 'reader-1', role: 'user' }, 'files.view'), true);
  assert.equal(accessRegistry.canPerform(sharedServer, { id: 'reader-1', role: 'user' }, 'console.send'), false);

  const frozenSupport = new ServerRouteSupportService({
    get: async () => ({ ...sharedServer, status: 'frozen', variables: { AGAPORNIS_FROZEN: 'true' } }),
    canAccess: () => true,
    canPerform: () => true,
    isFrozen: server => server.status === 'frozen'
  }, {}, {});
  await assert.rejects(
    frozenSupport.requireServerPermission('shared-1', { id: 'owner-1', role: 'user' }, 'power'),
    /frozen by an administrator/
  );
  await frozenSupport.requireServerPermission('shared-1', { id: 'owner-1', role: 'user' }, 'files.view');
  let observedStatusWrites = 0;
  const observedSupport = new ServerRouteSupportService({
    get: async () => ({ ...sharedServer, status: 'frozen', variables: { AGAPORNIS_FROZEN: 'true' } }),
    isFrozen: () => true,
    setStatus: async () => { observedStatusWrites += 1; }
  }, {}, {});
  const effectiveFrozenStatus = await observedSupport.recordObservedStatus('node-1', 'shared-1', 'stopped');
  assert.equal(observedStatusWrites, 0, 'agent telemetry must not overwrite a manual frozen state');
  assert.equal(effectiveFrozenStatus, 'frozen', 'frozen must be the effective realtime status');

  let manualServer = {
    id: 'manual-freeze',
    nodeId: 'node-1',
    status: 'running',
    variables: {}
  };
  let stopCalls = 0;
  const manualRegistry = {
    isFrozen: server => server.status === 'frozen' || server.variables.AGAPORNIS_FROZEN === 'true',
    updateSettings: async (_id, patch) => {
      manualServer = { ...manualServer, ...patch };
      return manualServer;
    },
    setStatus: async (_id, status) => {
      manualServer = { ...manualServer, status };
      return manualServer;
    }
  };
  const manualSupport = {
    requireNodeServerAccess: async () => manualServer,
    dispatchServerEvent: async () => undefined,
    clientIp: () => '127.0.0.1'
  };
  const manualController = new ServersController(
    { stopServer: async () => { stopCalls += 1; } },
    {},
    manualRegistry,
    { log: () => undefined },
    manualSupport,
    {},
    {},
    {},
    {},
    { powerAllForServer: async () => undefined },
    {}
  );
  await manualController.freezeServer(
    'node-1',
    'manual-freeze',
    { reason: 'Maintenance' },
    { user: { id: 'admin-1', role: 'admin' } }
  );
  assert.equal(manualServer.status, 'frozen');
  assert.equal(manualServer.variables.AGAPORNIS_FREEZE_REASON, 'Maintenance');
  assert.equal(stopCalls, 1);
  await manualController.unfreezeServer(
    'node-1',
    'manual-freeze',
    { user: { id: 'admin-1', role: 'admin' } }
  );
  assert.equal(manualServer.status, 'stopped');
  assert.equal(manualServer.variables.AGAPORNIS_FROZEN, undefined);

  let nodeDeleteCalls = 0;
  let databaseCleanupOptions;
  let removedServerId;
  const unavailableServer = { id: 'offline-server', nodeId: 'offline-node', status: 'created', variables: {} };
  const offlineDeletionController = new ServersController(
    { deleteServer: async () => { nodeDeleteCalls += 1; } },
    {},
    {
      claimDeletion: async () => ({ record: unavailableServer, replay: false, previousStatus: 'created' }),
      remove: async id => { removedServerId = id; },
      restoreDeletion: async () => undefined,
    },
    { log: () => undefined, pruneByServerId: async () => undefined },
    {
      requireNodeServerAccess: async () => unavailableServer,
      dispatchServerEvent: async () => undefined,
      clientIp: () => '127.0.0.1',
    },
    {}, {}, {}, {},
    { deleteAllForServer: async (_id, options) => { databaseCleanupOptions = options; } },
    {}, {}
  );
  const databaseCleanup = await offlineDeletionController.deleteServer(
    'offline-node',
    'offline-server',
    { forceDatabaseCleanup: true },
    { user: { id: 'admin-1', role: 'admin' } }
  );
  assert.equal(databaseCleanup.success, true);
  assert.equal(databaseCleanup.databaseOnlyCleanup, true);
  assert.equal(databaseCleanupOptions.skipAgent, true, 'database-only deletion must not contact database containers on an offline node');
  assert.equal(nodeDeleteCalls, 0, 'database-only deletion must not contact the offline game-server container');
  assert.equal(removedServerId, 'offline-server');

  const allocationRegistry = Object.create(ServerRegistryService.prototype);
  allocationRegistry.database = { clientType: 'json' };
  const allocationRecord = { id: 'ports-1', nodeId: 'node-1', status: 'provisioning', assignedHostPort: 30002, variables: { SERVER_PORT: '25565', QUERY_PORT: '27015' } };
  allocationRegistry.get = async () => allocationRecord;
  allocationRegistry.usedPorts = async () => new Set([30002, 30003]);
  allocationRegistry.initializeProvisioningSettings = async (_id, patch) => ({ ...allocationRecord, ...patch });
  const allocated = await allocationRegistry.assignPortAllocations('ports-1', 2, 30000, 30010);
  const mappings = allocationRegistry.portMappings(allocated.variables);
  assert.deepEqual(mappings.map(mapping => mapping.hostPort), [30002, 30000]);
  assert.deepEqual(mappings.map(mapping => mapping.internalPort), [25565, 27015]);
  assert.equal(allocated.variables.SERVER_PORT, '25565', 'allocating a public port must not rewrite the workload port');

  let livePortRecord = { ...allocated, status: 'created' };
  allocationRegistry.get = async () => livePortRecord;
  allocationRegistry.usedPorts = async () => new Set(mappings.map(mapping => mapping.hostPort));
  allocationRegistry.nodePortRange = async () => ({ start: 30000, end: 30010 });
  allocationRegistry.updateSettings = async (_id, patch) => { livePortRecord = { ...livePortRecord, ...patch }; return livePortRecord; };
  const reconciledVariables = await allocationRegistry.reconcilePortAllocations('ports-1', {
    ...livePortRecord.variables,
    SERVER_PORT: '25565',
    QUERY_PORT: '27015',
    SERVER_PORT_3: '27016'
  });
  const reconciled = allocationRegistry.portMappings(reconciledVariables);
  assert.equal(reconciled.length, 3, 'saving the comma-separated admin port field must reserve added ports');
  assert.deepEqual(reconciled.map(mapping => mapping.internalPort), [25565, 27015, 27016]);
  assert.equal(reconciledVariables.SERVER_PORT_3, undefined);
  assert.equal(reconciledVariables.ADDITIONAL_PORT_2, '27016');

  let expansionRecord = {
    id: 'expansion-1', nodeId: 'node-1', status: 'created', assignedHostPort: 25742,
    variables: {
      SERVER_PORT: '25742',
      AGAPORNIS_PORT_MAPPINGS: JSON.stringify([{ variable: 'SERVER_PORT', internalPort: 25742, hostPort: 25742, protocol: 'tcp' }])
    }
  };
  allocationRegistry.get = async () => expansionRecord;
  allocationRegistry.usedPorts = async () => new Set([25742]);
  allocationRegistry.nodePortRange = async () => ({ start: 25742, end: 25800 });
  allocationRegistry.updateSettings = async (_id, patch) => { expansionRecord = { ...expansionRecord, ...patch }; return expansionRecord; };
  const expandedVariables = await allocationRegistry.reconcilePortAllocations('expansion-1', {
    ...expansionRecord.variables,
    SERVER_PORT: '9999',
    SERVER_PORT_2: '25743'
  });
  const expandedMappings = allocationRegistry.portMappings(expandedVariables);
  assert.equal(expandedVariables.SERVER_PORT, '25742', 'adding an allocation must preserve SERVER_PORT');
  assert.equal(expandedVariables.SERVER_PORT_2, undefined, 'additional allocations must not be linked to SERVER_PORT_N');
  assert.equal(expandedVariables.ADDITIONAL_PORT_1, '25743');
  assert.deepEqual(expandedMappings.map(mapping => mapping.variable), ['SERVER_PORT', 'ADDITIONAL_PORT_1']);
  assert.deepEqual(expandedMappings.map(mapping => mapping.hostPort), [25742, 25743]);
  assert.deepEqual(expandedMappings.map(mapping => mapping.internalPort), [25742, 25743]);

  let corruptedSecondaryRecord = {
    id: 'secondary-repair', nodeId: 'node-1', status: 'created', assignedHostPort: 25991,
    variables: {
      SERVER_PORT: '25991', SERVER_PORT_2: '25565',
      AGAPORNIS_PORT_MAPPINGS: JSON.stringify([
        { variable: 'SERVER_PORT', internalPort: 25991, hostPort: 25991, protocol: 'tcp' },
        { variable: 'SERVER_PORT_2', internalPort: 25565, hostPort: 26991, protocol: 'tcp' }
      ])
    }
  };
  allocationRegistry.get = async () => corruptedSecondaryRecord;
  allocationRegistry.usedPorts = async () => new Set([25991, 26991]);
  allocationRegistry.nodePortRange = async () => ({ start: 25000, end: 27000 });
  allocationRegistry.updateSettings = async (_id, patch) => { corruptedSecondaryRecord = { ...corruptedSecondaryRecord, ...patch }; return corruptedSecondaryRecord; };
  const repairedVariables = await allocationRegistry.reconcilePortAllocations('secondary-repair', corruptedSecondaryRecord.variables);
  const repairedMappings = allocationRegistry.portMappings(repairedVariables);
  assert.equal(repairedVariables.SERVER_PORT, '25991');
  assert.equal(repairedVariables.SERVER_PORT_2, undefined);
  assert.equal(repairedVariables.ADDITIONAL_PORT_1, '26991');
  assert.deepEqual(repairedMappings.map(mapping => [mapping.internalPort, mapping.hostPort]), [[25991, 25991], [26991, 26991]]);

  let explicitPortRecord = {
    id: 'explicit-port', nodeId: 'node-1', status: 'created', assignedHostPort: 25991,
    variables: {
      SERVER_PORT: '25991',
      AGAPORNIS_PORT_MAPPINGS: JSON.stringify([{ variable: 'SERVER_PORT', internalPort: 25991, hostPort: 25991, protocol: 'tcp' }])
    }
  };
  allocationRegistry.get = async () => explicitPortRecord;
  allocationRegistry.usedPorts = async () => new Set([25991]);
  allocationRegistry.nodePortRange = async () => ({ start: 25565, end: 26000 });
  allocationRegistry.updateSettings = async (_id, patch) => { explicitPortRecord = { ...explicitPortRecord, ...patch }; return explicitPortRecord; };
  const outsideRangeVariables = await allocationRegistry.reconcilePortAllocations('explicit-port', {
    ...explicitPortRecord.variables,
    ADDITIONAL_PORT_1: '2599'
  });
  assert.deepEqual(allocationRegistry.portMappings(outsideRangeVariables).map(mapping => mapping.hostPort), [25991, 2599]);

  explicitPortRecord = {
    ...explicitPortRecord,
    variables: {
      SERVER_PORT: '25991',
      AGAPORNIS_PORT_MAPPINGS: JSON.stringify([{ variable: 'SERVER_PORT', internalPort: 25991, hostPort: 25991, protocol: 'tcp' }])
    }
  };
  allocationRegistry.usedPorts = async () => new Set([25991, 2599]);
  await assert.rejects(
    () => allocationRegistry.reconcilePortAllocations('explicit-port', { ...explicitPortRecord.variables, ADDITIONAL_PORT_1: '2599' }),
    /requested port 2599 is already in use/
  );

  const databaseService = Object.create(ServerDatabasesService.prototype);
  const databasePort = databaseService.choosePort(33060, 33062, [33060, 33061]);
  assert.equal(databasePort, 33062, 'database allocation must skip ports already used on the node');
  const databaseRequest = databaseService.createRequest({
    serverId: 'server-1', containerId: 'db-server-1', dockerImage: 'mariadb:11', port: databasePort,
    databaseName: 'db_server_1', username: 'u_test', password: 'secret', memoryBytes: 512, diskLimitBytes: 1024,
    cpuLimitPercentage: 50
  });
  assert.equal(databaseRequest.internal_port, '33062/tcp');
  assert.equal(databaseRequest.expose_public_port, false);
  assert.ok(databaseRequest.env_vars.includes('AGAPORNIS_DATABASE_PORT=33062'));
  assert.equal(databaseRequest.docker_image, 'mariadb:latest', 'database images must come from the strict catalog');
  const postgresRequest = databaseService.createRequest({
    type: 'postgres', serverId: 'server-1', containerId: 'db-postgres', dockerImage: 'attacker/custom:latest', port: 33063,
    databaseName: 'db_postgres', username: 'u_pg', password: 'secret', memoryBytes: 512, diskLimitBytes: 1024,
    cpuLimitPercentage: 50
  });
  assert.equal(postgresRequest.docker_image, 'postgres:latest');
  assert.ok(postgresRequest.env_vars.includes('POSTGRES_DB=db_postgres'));
  const mysqlRequest = databaseService.createRequest({
    type: 'mysql', serverId: 'server-1', containerId: 'db-mysql', port: 33064,
    databaseName: 'db_mysql', username: 'u_mysql', password: 'secret', memoryBytes: 512, diskLimitBytes: 1024,
    cpuLimitPercentage: 50
  });
  assert.equal(mysqlRequest.docker_image, 'mysql:latest');
  const databasePolicy = support.databasePatch({
    databaseDockerImage: 'attacker/custom:latest', allowedDatabaseTypes: ['mysql', 'postgres'], databasePortRangeMode: 'game'
  });
  assert.equal(databasePolicy.databaseDockerImage, undefined, 'custom database images must be ignored');
  assert.deepEqual(databasePolicy.allowedDatabaseTypes, ['mysql', 'postgres']);
  assert.equal(databasePolicy.databasePortRangeMode, 'game');

  const fileController = new ServerFilesController({}, {
    requirePath: () => undefined,
    requireNodeServerPermission: async () => undefined,
    forward: async (_action, _nodeId, _serverId, callback) => callback()
  });
  await assert.rejects(
    fileController.renameFileOrDirectory('node-1', 'server-1', { path: '/safe.txt', newName: '../outside.txt' }, { user: {} }),
    /single file or directory name/,
    'rename must reject path traversal'
  );
  await assert.rejects(
    fileController.extractArchive('node-1', 'server-1', { path: 'https://example.invalid/archive.zip', destinationPath: '/' }, { user: {} }),
    /remote archive sources and destinations are not allowed/,
    'archive extraction must reject remote sources'
  );
  const binaryPreviewError = support.fileReadError({
    code: 3,
    details: 'File is not valid UTF-8'
  });
  assert.equal(binaryPreviewError.status, 415);
  assert.equal(binaryPreviewError.body.code, 'file_preview_not_text');
  assert.match(binaryPreviewError.body.errorMessage, /download it instead/i);
  const largePreviewError = support.fileReadError({
    code: 13,
    message: '13 INTERNAL: File is too large to read into memory.'
  });
  assert.equal(largePreviewError.status, 413);
  assert.equal(largePreviewError.body.code, 'file_preview_too_large');
  assert.match(largePreviewError.body.errorMessage, /5 MiB preview limit/i);
  assert.equal(support.fileReadError({ message: 'connection refused' }), undefined, 'unknown agent failures must remain generic');
  await assert.rejects(
    fileController.moveFiles('node-1', 'server-1', { sourcePaths: ['/safe.txt'], destinationPath: 'https://example.invalid/files' }, { user: {} }),
    /remote file paths are not allowed/,
    'move must reject remote destinations'
  );
  await assert.rejects(
    fileController.createArchive('node-1', 'server-1', { sourcePaths: ['/safe.txt'], destinationPath: '/bundle.zip' }, { user: {} }),
    /must end with \.tar\.gz/,
    'archive creation must require the supported archive format'
  );
  await assert.rejects(
    fileController.moveFiles('node-1', 'server-1', { sourcePaths: Array.from({ length: 101 }, (_, index) => `/file-${index}`), destinationPath: '/' }, { user: {} }),
    /between 1 and 100 paths/,
    'bulk file actions must remain bounded'
  );

  const lifecycleRegistry = Object.create(ServerRegistryService.prototype);
  lifecycleRegistry.database = { clientType: 'json' };
  let lifecycleRecord = { id: 'provisioning-1', status: 'provisioning', variables: {} };
  lifecycleRegistry.get = async () => lifecycleRecord;
  lifecycleRegistry.upsert = async record => { lifecycleRecord = record; return record; };
  await lifecycleRegistry.initializeProvisioningSettings('provisioning-1', { variables: { VERSION: '1.21.8' } });
  assert.equal(lifecycleRecord.variables.VERSION, '1.21.8', 'internal initialization must work during provisioning');
  await assert.rejects(
    lifecycleRegistry.updateSettings('provisioning-1', { variables: { VERSION: 'changed' } }),
    /server settings cannot change while provisioning/,
    'normal settings writes must remain blocked during provisioning'
  );
  await assert.rejects(
    lifecycleRegistry.claimDeletion('provisioning-1'),
    /still provisioning/,
    'normal deletion must remain blocked while provisioning'
  );
  const recoveryClaim = await lifecycleRegistry.claimDeletion('provisioning-1', true);
  assert.equal(recoveryClaim.previousStatus, 'provisioning');
  assert.equal(lifecycleRecord.status, 'deleting', 'explicit recovery cleanup must atomically claim the stuck record');
  lifecycleRecord = { ...lifecycleRecord, status: 'provisioning' };
  lifecycleRecord = { ...lifecycleRecord, status: 'created' };
  await assert.rejects(
    lifecycleRegistry.initializeProvisioningSettings('provisioning-1', { variables: { VERSION: 'wrong-phase' } }),
    /requires provisioning status/,
    'the internal initialization path must not work after provisioning'
  );
  await lifecycleRegistry.updateSettings('provisioning-1', { variables: { VERSION: '1.21.9' } });
  assert.equal(lifecycleRecord.variables.VERSION, '1.21.9');

  console.log('Server policy self-test passed: provisioning, variables, and collaborator permissions are enforced.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
