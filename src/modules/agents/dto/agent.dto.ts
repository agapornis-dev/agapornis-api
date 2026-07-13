export class RegisterAgentDto {
  nodeId!: string;
  fqdn?: string;
  grpcAddress?: string;
  grpc_address?: string;
  grpcPort?: number;
  grpc_port?: number;
  secure?: boolean;
  status?: string;
  location?: string;
  portRangeStart?: number;
  port_range_start?: number;
  portRangeEnd?: number;
  port_range_end?: number;
  memoryOverallocationMb?: number;
  memoryLimitMb?: number;
  diskLimitMb?: number;
  diskOverallocationMb?: number;
  maintenanceMode?: boolean;
}

export class UpdatePlacementDto {
  location?: string;
  portRangeStart?: number;
  port_range_start?: number;
  portRangeEnd?: number;
  port_range_end?: number;
  memoryOverallocationMb?: number;
  memoryLimitMb?: number;
  diskLimitMb?: number;
  diskOverallocationMb?: number;
  maintenanceMode?: boolean;
}

export class ApplyAgentUpdateDto {
  artifactUrl?: string;
  artifact_url?: string;
  sha256?: string;
}
