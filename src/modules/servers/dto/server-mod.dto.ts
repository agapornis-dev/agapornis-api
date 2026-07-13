export class InstallServerModDto {
  provider?: string;
  projectId?: string;
  projectType?: string;
  type?: string;
  versionId?: string;
  gameVersion?: string;
  loader?: string;
}

export class RemoveServerModDto {
  fileName?: string;
  file_name?: string;
}
