import { ServerVariablesDto } from './server-shared.dto';

export class CreateServerFromEggDto {
  eggId?: string;
  egg_id?: string;
  location?: string;
  nodeId?: string;
  node_id?: string;
  serverId?: string;
  server_id?: string;
  name?: string;
  dockerImage?: string;
  docker_image?: string;
  allowedEggIds?: string[];
  allowed_egg_ids?: string[];
  variables?: ServerVariablesDto;
}

export class ProvisionServerFromEggDto extends CreateServerFromEggDto {}
