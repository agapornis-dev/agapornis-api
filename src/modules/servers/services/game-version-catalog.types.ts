export interface GameVersionOption {
  id: string;
  label: string;
  channel: 'stable' | 'experimental';
  recommended?: boolean;
}

export interface GameEggDescriptor {
  eggId: string;
  name: string;
  description?: string;
  gameId: string;
  gameName: string;
  family: string;
  kind: 'server' | 'proxy' | 'mod-loader';
  provider: string;
  versionLabel: string;
  buildLabel: string;
  versionVariable?: string;
  buildVariable?: string;
  currentVersion?: string;
  currentBuild?: string;
  jarInstallSupported: boolean;
  jarInstallReason?: string;
}

export interface RuntimeArtifact {
  provider: string;
  version: string;
  build?: string;
  url: string;
  fileName: string;
}
