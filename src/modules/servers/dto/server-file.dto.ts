export class WriteServerFileDto {
  path?: string;
  content?: string;
}

export class RenameServerFileDto {
  newName?: string;
  new_name?: string;
}

export class ExtractServerArchiveDto {
  destinationPath?: string;
  destination_path?: string;
}

export class CreateServerDirectoryDto {
  path?: string;
}

export class MoveServerFilesDto {
  sourcePaths?: string[];
  source_paths?: string[];
  destinationPath?: string;
  destination_path?: string;
}

export class CreateServerArchiveDto extends MoveServerFilesDto {}
