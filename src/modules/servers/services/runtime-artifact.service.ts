import { Injectable } from '@nestjs/common';
import * as https from 'https';
import { RuntimeArtifact } from './game-version-catalog.types';

const TRUSTED_ARTIFACT_HOSTS = new Set(['fill.papermc.io', 'fill-data.papermc.io', 'api.purpurmc.org', 'meta.fabricmc.net', 'meta.quiltmc.org', 'piston-data.mojang.com', 'launcher.mojang.com']);
const MAX_RUNTIME_ARTIFACT_BYTES = 128 * 1024 * 1024;

@Injectable()
export class RuntimeArtifactService {
  artifact(provider: string, version: string, build: string | undefined, url: string): RuntimeArtifact {
    if (!url) throw new Error(`${provider} did not publish a downloadable server JAR for this selection`);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !TRUSTED_ARTIFACT_HOSTS.has(parsed.hostname)) throw new Error('runtime artifact source is not trusted');
    return { provider, version, build, url: parsed.toString(), fileName: 'server.jar' };
  }

  async *download(artifact: RuntimeArtifact): AsyncGenerator<Buffer> {
    const response = await this.response(artifact.url);
    const declaredSize = Number(response.headers['content-length'] || 0);
    if (declaredSize > MAX_RUNTIME_ARTIFACT_BYTES) {
      response.destroy();
      throw new Error('runtime JAR exceeds the 128 MB safety limit');
    }
    let size = 0;
    let prefix = Buffer.alloc(0);
    for await (const rawChunk of response) {
      const chunk = Buffer.from(rawChunk);
      size += chunk.length;
      if (size > MAX_RUNTIME_ARTIFACT_BYTES) {
        response.destroy();
        throw new Error('runtime JAR exceeds the 128 MB safety limit');
      }
      if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk]).subarray(0, 4);
      yield chunk;
    }
    if (size === 0 || prefix.length < 2 || prefix[0] !== 0x50 || prefix[1] !== 0x4b) throw new Error('runtime download was not a valid JAR file');
  }

  private response(url: string, redirects = 0): Promise<import('http').IncomingMessage> {
    if (redirects > 3) return Promise.reject(new Error('runtime download redirected too many times'));
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !TRUSTED_ARTIFACT_HOSTS.has(parsed.hostname)) return Promise.reject(new Error('runtime artifact source is not trusted'));
    return new Promise((resolve, reject) => {
      const request = https.get(parsed, { headers: { Accept: 'application/java-archive, application/octet-stream', 'User-Agent': 'Agapornis-Version-Catalog/1.0 (https://github.com/Nullptr-exe/agapornis)' } }, response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          void this.response(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`runtime download returned HTTP ${response.statusCode || 0}`));
          return;
        }
        resolve(response);
      });
      request.setTimeout(30_000, () => request.destroy(new Error('runtime download timed out')));
      request.on('error', reject);
    });
  }
}
