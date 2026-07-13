export type ServerVariablesDto = Record<string, string | number | boolean | null | undefined>;

export class VersionSelectionDto {
  provider?: string;
  version?: string;
  build?: string;
  loader?: string;
  fork?: string;
}
