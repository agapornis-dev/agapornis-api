import { EggDefinition, EggDockerImage, ResolvedEggServer } from './eggs.types';

/**
 * Pure-function helpers for resolving an egg definition into a concrete server
 * configuration. Extracted from EggsService to keep the service focused on
 * CRUD and persistence.
 */

export function resolveServer(egg: EggDefinition, body: any): ResolvedEggServer {
  const serverId = body?.serverId || body?.server_id;
  if (!serverId) throw new Error('serverId is required');

  const provided = normalizeValues(body?.variables || body?.env || {});
  const env = { ...egg.environment };
  const primaryPort = String(body?.serverPort || body?.server_port || body?.port || valueForKey(provided, 'SERVER_PORT') || env.SERVER_PORT || 25565);

  env.SERVER_MEMORY = String(body?.memoryMb || body?.memory_mb || Math.floor(Number(body?.memoryBytes || body?.memory_bytes || 0) / 1024 / 1024) || env.SERVER_MEMORY || 1024);
  env.SERVER_DISK = String(body?.diskMb || body?.disk_mb || Math.floor(Number(body?.diskBytes || body?.disk_bytes || 0) / 1024 / 1024) || env.SERVER_DISK || 10240);
  env.SERVER_PORT = primaryPort;
  env.SERVER_CPU = String(body?.cpuLimitPercentage || body?.cpu_limit_percentage || env.SERVER_CPU || 100);
  delete env.SERVER_CPU_CORES;
  env.SERVER_ID = serverId;

  for (const variable of egg.variables) {
    const value = (valueForKey(provided, variable.envVariable) ?? variable.defaultValue) || generatedVariableDefault(variable.envVariable, body, env);
    if (variable.required && !value) {
      throw new Error(`egg variable '${variable.envVariable}' is required`);
    }
    env[variable.envVariable] = String(value ?? '');
  }

  for (const [key, value] of Object.entries(provided)) {
    env[key] = String(value ?? '');
  }

  env.SERVER_MEMORY = String(body?.memoryMb || body?.memory_mb || Math.floor(Number(body?.memoryBytes || body?.memory_bytes || 0) / 1024 / 1024) || env.SERVER_MEMORY || 1024);
  env.SERVER_DISK = String(body?.diskMb || body?.disk_mb || Math.floor(Number(body?.diskBytes || body?.disk_bytes || 0) / 1024 / 1024) || env.SERVER_DISK || 10240);
  env.SERVER_PORT = primaryPort;
  env.SERVER_CPU = String(body?.cpuLimitPercentage || body?.cpu_limit_percentage || env.SERVER_CPU || 100);
  delete env.SERVER_CPU_CORES;
  env.SERVER_ID = serverId;

  const startup = interpolate(egg.startup, env);
  env.STARTUP = startup;
  const install = egg.install;
  if (egg.raw?.scripts?.installation && !install?.script) {
    throw new Error(`egg '${egg.id}' has an installation script, but it was not available during server resolution`);
  }

  return {
    server_id: serverId,
    docker_image: resolveDockerImage(egg, body?.dockerImage || body?.docker_image || body?.image),
    internal_port: String(body?.internalPort || body?.internal_port || `${env.SERVER_PORT}/tcp`),
    env_vars: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    memory_bytes: Number(body?.memoryBytes || body?.memory_bytes || Number(env.SERVER_MEMORY) * 1024 * 1024),
    cpu_limit_percentage: Number(body?.cpuLimitPercentage || body?.cpu_limit_percentage || 100),
    cpu_cores: 0,
    disk_limit_bytes: Number(body?.diskBytes || body?.disk_bytes || Number(env.SERVER_DISK) * 1024 * 1024),
    cpu_pinning: Boolean(body?.cpuPinnedThreads || body?.cpu_pinned_threads || body?.cpuPinning || body?.cpu_pinning),
    cpu_pinned_threads: String(body?.cpuPinnedThreads || body?.cpu_pinned_threads || ''),
    swap_memory_bytes: Number(body?.swapMemoryBytes || body?.swap_memory_bytes || Number(body?.swapMemoryMb || body?.swap_memory_mb || 0) * 1024 * 1024),
    swap_memory_storage: String(body?.swapMemoryStorage || body?.swap_memory_storage || 'general') === 'server' ? 'server' : 'general',
    startup_command: startup,
    stop_command: interpolate(egg.stopCommand || '', env),
    startup_done: interpolate(egg.startupDone || '', env),
    install_image: install?.container || '',
    install_entrypoint: install?.entrypoint || '',
    install_script: interpolate(install?.script || '', env),
    config_files_json: JSON.stringify(resolveConfigFiles(egg.configFiles || {}, env)),
    host_port: Number(body?.hostPort || body?.host_port || body?.port || 0) || 0,
    network_owner_id: String(body?.networkOwnerId || body?.network_owner_id || serverId),
    expose_public_port: body?.exposePublicPort === undefined && body?.expose_public_port === undefined
      ? true
      : Boolean(body?.exposePublicPort ?? body?.expose_public_port),
    port_mappings: body?.portMappings || body?.port_mappings || [],
    egg: {
      id: egg.id,
      name: egg.name
    }
  };
}

export function normalizeValues(values: Record<string, any>) {
  return Object.entries(values).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key.toUpperCase()] = String(value ?? '');
    return acc;
  }, {});
}

export function interpolate(template: string, env: Record<string, string>) {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) => {
    const placeholder = String(key).trim();
    const value = valueForPlaceholder(placeholder, env);
    if (value !== undefined) return value;
    return /^config\./.test(placeholder) ? match : '';
  });
}

export function valueForKey(values: Record<string, string>, key: string) {
  return values[key] ?? values[key.toUpperCase()] ?? values[key.toLowerCase()];
}

function valueForPlaceholder(key: string, env: Record<string, string>) {
  const normalized = key.trim().replace(/^env\./i, '').toUpperCase();
  const aliases: Record<string, string> = {
    'SERVER.BUILD.DEFAULT.PORT': 'SERVER_PORT',
    'SERVER.BUILD.MEMORY': 'SERVER_MEMORY',
    'SERVER.BUILD.DISK': 'SERVER_DISK',
    'SERVER.BUILD.CPU': 'SERVER_CPU',
    'SERVER.UUID': 'SERVER_ID',
    'SERVER.ID': 'SERVER_ID'
  };

  if (/^SERVER\.BUILD\.ENV\./i.test(key.trim())) {
    return valueForKey(env, key.trim().replace(/^server\.build\.env\./i, ''));
  }

  return valueForKey(env, aliases[normalized] || normalized);
}

function generatedVariableDefault(envVariable: string, body: any, env: Record<string, string>) {
  const key = envVariable.toUpperCase();
  const primaryPort = String(body?.serverPort || body?.server_port || body?.port || env.SERVER_PORT || 25565);
  const aliases: Record<string, string> = {
    QUERY_PORT: String(body?.queryPort || body?.query_port || body?.serverQueryPort || body?.server_query_port || primaryPort),
    QUERYPORT: String(body?.queryPort || body?.query_port || body?.serverQueryPort || body?.server_query_port || primaryPort),
    STEAM_QUERY_PORT: String(body?.queryPort || body?.query_port || body?.serverQueryPort || body?.server_query_port || primaryPort),
    SERVER_QUERY_PORT: String(body?.queryPort || body?.query_port || body?.serverQueryPort || body?.server_query_port || primaryPort),
    GAME_PORT: primaryPort,
    PORT: primaryPort
  };

  return aliases[key] || '';
}

export function resolveDockerImage(egg: EggDefinition, requested?: string) {
  const options = dockerImageOptions(egg);
  if (!requested) return options[0]?.image || egg.images[0];

  const value = String(requested);
  const match = options.find(item => item.image === value || item.label === value);
  return match?.image || value;
}

export function dockerImageOptions(egg: EggDefinition): EggDockerImage[] {
  const options = egg.dockerImages?.length
    ? egg.dockerImages
    : (egg.images || []).map(image => ({ label: image, image }));

  return options
    .map((option, index) => ({ option, index, java: javaRuntimeVersion(option) }))
    .sort((left, right) => {
      if (left.java !== right.java) return right.java - left.java;
      return left.index - right.index;
    })
    .map(({ option }) => option);
}

function javaRuntimeVersion(option: EggDockerImage) {
  const value = `${option.label} ${option.image}`.toLowerCase();
  const match = value.match(/(?:java|jdk|jre)[^0-9]{0,8}(\d{1,2})/i);
  return match ? Number(match[1]) : -1;
}

export function resolveConfigFiles(configFiles: Record<string, any>, env: Record<string, string>) {
  return Object.entries(configFiles).reduce<Record<string, any>>((acc, [file, config]) => {
    const find = config?.find && typeof config.find === 'object'
      ? Object.entries(config.find).reduce<Record<string, any>>((next, [key, value]) => {
        next[key] = interpolateConfigValue(value, env);
        return next;
      }, {})
      : {};

    acc[file] = {
      ...config,
      find
    };
    return acc;
  }, {});
}

function interpolateConfigValue(value: any, env: Record<string, string>): any {
  if (typeof value === 'string') return interpolate(value, env);
  if (Array.isArray(value)) return value.map(item => interpolateConfigValue(item, env));
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce<Record<string, any>>((output, [key, item]) => {
      output[key] = interpolateConfigValue(item, env);
      return output;
    }, {});
  }
  return value;
}
