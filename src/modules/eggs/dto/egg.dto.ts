export class CreateEggNestDto {
  id?: string;
  name?: string;
  description?: string;
}

export class UpdateEggNestDto {
  name?: string;
  description?: string;
}

export class AssignEggNestDto {
  nestId?: string;
  nest_id?: string;
}

export class ImportEggDto {
  id?: string;
  eggId?: string;
  name?: string;
  description?: string;
  category?: string;
  dockerImages?: Record<string, string>;
  variables?: unknown[];
}

export class ImportEggBatchDto {
  eggs?: ImportEggDto[];
}
