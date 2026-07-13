export interface EggCatalogItem {
  id: string;
  eggId: string;
  name: string;
  category: string;
  description: string;
  sourceUrl?: string;
  bundled?: boolean;
}

export interface EggDefinition {
  id: string;
  nestId: string;
  name: string;
  description?: string;
  images: string[];
  dockerImages: EggDockerImage[];
  startup: string;
  stopCommand: string;
  startupDone: string;
  environment: Record<string, string>;
  variables: EggVariable[];
  install?: EggInstallScript;
  configFiles?: Record<string, any>;
  raw: any;
}

export interface EggNest {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface EggDockerImage {
  label: string;
  image: string;
}

export interface EggVariable {
  name: string;
  envVariable: string;
  defaultValue: string;
  required: boolean;
  userEditable: boolean;
  description?: string;
}

export interface ResolvedEggServer {
  server_id: string;
  docker_image: string;
  internal_port: string;
  env_vars: string[];
  memory_bytes: number;
  cpu_limit_percentage: number;
  cpu_cores: number;
  disk_limit_bytes: number;
  cpu_pinning: boolean;
  cpu_pinned_threads: string;
  swap_memory_bytes: number;
  swap_memory_storage: 'server' | 'general';
  startup_command: string;
  stop_command: string;
  startup_done: string;
  install_image: string;
  install_entrypoint: string;
  install_script: string;
  config_files_json: string;
  host_port: number;
  network_owner_id: string;
  expose_public_port: boolean;
  port_mappings?: Array<{ variable: string; internal_port: string; host_port: number }>;
  egg: {
    id: string;
    name: string;
  };
}

export interface EggInstallScript {
  container: string;
  entrypoint: string;
  script: string;
}
