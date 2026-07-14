export type PanelComponent = 'api' | 'frontend';
export type ReleaseComponent = PanelComponent | 'agent';

export interface UpdateArtifact {
  url: string;
  sha256: string;
  sizeBytes?: number;
}

export interface ReleaseManifestBase {
  schemaVersion: 1;
  component: ReleaseComponent;
  version: string;
  channel: string;
  publishedAt?: string;
  releaseNotes?: string;
  releaseUrl?: string;
}

export interface PanelReleaseManifest extends ReleaseManifestBase {
  component: PanelComponent;
  artifact: UpdateArtifact;
}

export interface AgentReleaseManifest extends ReleaseManifestBase {
  component: 'agent';
  artifacts: Record<string, UpdateArtifact>;
}

export interface StagedArtifact {
  component: PanelComponent;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface PanelUpdateState {
  status: 'idle' | 'staging' | 'staged' | 'applying' | 'completed' | 'failed';
  targetVersions?: Partial<Record<PanelComponent, string>>;
  /** Compatibility with update state written by the former unified release. */
  targetVersion?: string;
  startedAt?: string;
  stagedAt?: string;
  applyStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorMessage?: string;
  manualApplyRequired?: boolean;
  artifacts?: StagedArtifact[];
}
