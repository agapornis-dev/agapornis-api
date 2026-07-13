export function requestedServerId(body: any) {
  return body?.serverId || body?.server_id;
}

export function filePathFromBody(body: any) {
  return body?.targetPath || body?.target_path || body?.path;
}

export function createServerRequest(body: any) {
  return {
    server_id: requestedServerId(body),
    docker_image: body?.dockerImage || body?.docker_image,
    internal_port: String(body?.internalPort || body?.internal_port || ''),
    env_vars: body?.envVars || body?.env_vars || [],
    memory_bytes: memoryBytes(body) || 0,
    cpu_limit_percentage: cpuLimitPercentage(body) || 0,
    cpu_cores: 0,
    disk_limit_bytes: diskLimitBytes(body) || 0,
    cpu_pinning: cpuPinning(body),
    cpu_pinned_threads: cpuPinnedThreads(body),
    swap_memory_bytes: swapMemoryBytes(body) || 0,
    swap_memory_storage: swapMemoryStorage(body),
    startup_command: body?.startupCommand || body?.startup_command || '',
    stop_command: body?.stopCommand || body?.stop_command || '',
    startup_done: body?.startupDone || body?.startup_done || '',
    install_image: body?.installImage || body?.install_image || '',
    install_entrypoint: body?.installEntrypoint || body?.install_entrypoint || '',
    install_script: body?.installScript || body?.install_script || '',
    config_files_json: body?.configFilesJson || body?.config_files_json || '',
    host_port: Number(body?.hostPort || body?.host_port || body?.port || 0) || 0,
    network_owner_id: body?.networkOwnerId || body?.network_owner_id || requestedServerId(body) || '',
    expose_public_port: body?.exposePublicPort === undefined && body?.expose_public_port === undefined
      ? true
      : Boolean(body?.exposePublicPort ?? body?.expose_public_port),
    port_mappings: body?.portMappings || body?.port_mappings || []
  };
}

export function memoryBytes(body: any) {
  const bytes = Number(body?.memoryBytes || body?.memory_bytes || body?.memoryLimitBytes || body?.memory_limit_bytes || 0);
  if (bytes > 0) return bytes;

  const mb = Number(body?.memoryMb || body?.memory_mb || 0);
  return mb > 0 ? mb * 1024 * 1024 : undefined;
}

export function cpuLimitPercentage(body: any) {
  const value = Number(body?.cpuLimitPercentage || body?.cpu_limit_percentage || 0);
  return value > 0 ? value : undefined;
}

export function cpuCores(body: any) {
  const value = Number(body?.cpuCores || body?.cpu_cores || 0);
  return value > 0 ? value : undefined;
}

export function cpuPinning(body: any) {
  return Boolean(cpuPinnedThreads(body));
}

export function cpuPinnedThreads(body: any) {
  const raw = String(body?.cpuPinnedThreads ?? body?.cpu_pinned_threads ?? '').replace(/\s+/g, '');
  if (!raw) return '';
  for (const segment of raw.split(',')) {
    if (!/^\d+(?:-\d+)?$/.test(segment)) throw new Error('pinned CPU threads must use values like 0, 1, or 2-4,6');
    const [start, end = start] = segment.split('-').map(Number);
    if (end < start) throw new Error(`invalid pinned CPU thread range '${segment}'`);
  }
  return raw;
}

export function swapMemoryBytes(body: any) {
  const bytes = Number(body?.swapMemoryBytes ?? body?.swap_memory_bytes ?? 0);
  if (Number.isFinite(bytes) && bytes > 0) return bytes;
  const mb = Number(body?.swapMemoryMb ?? body?.swap_memory_mb ?? 0);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0;
}

export function swapMemoryStorage(body: any): 'server' | 'general' {
  return String(body?.swapMemoryStorage ?? body?.swap_memory_storage ?? 'general').toLowerCase() === 'server'
    ? 'server'
    : 'general';
}

export function requiredStorageBytes(body: any) {
  const disk = diskLimitBytes(body) || 0;
  return swapMemoryStorage(body) === 'general' ? disk + swapMemoryBytes(body) : disk;
}

export function diskLimitBytes(body: any) {
  const bytes = Number(body?.diskBytes || body?.disk_bytes || body?.diskLimitBytes || body?.disk_limit_bytes || 0);
  if (bytes > 0) return bytes;

  const mb = Number(body?.diskMb || body?.disk_mb || 0);
  return mb > 0 ? mb * 1024 * 1024 : undefined;
}

export function normalizeVariables(values: Record<string, any> | string[]) {
  if (Array.isArray(values)) return envVarsToRecord(values);

  return Object.entries(values || {}).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[String(key).toUpperCase()] = String(value ?? '');
    return acc;
  }, {});
}

export function envVarsToRecord(values: string[] = []) {
  return values.reduce<Record<string, string>>((acc, item) => {
    const idx = String(item).indexOf('=');
    if (idx <= 0) return acc;
    acc[item.slice(0, idx).trim().toUpperCase()] = item.slice(idx + 1);
    return acc;
  }, {});
}

export function downloadFileName(targetPath: string) {
  const name = String(targetPath).split(/[\\/]/).filter(Boolean).pop() || 'download.bin';
  return name.replace(/[\u0000-\u001f\u007f"']/g, '').slice(0, 255) || 'download.bin';
}
