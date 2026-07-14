import * as fs from 'fs';
import * as path from 'path';
import { ApiConfigService } from './config.service';

export type ApiTlsOptions = {
  key: Buffer;
  cert: Buffer;
  ca?: Buffer;
  passphrase?: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
};

export function loadApiTlsOptions(config: ApiConfigService): ApiTlsOptions | undefined {
  const keyPath = config.get('API_TLS_KEY_PATH').trim();
  const certPath = config.get('API_TLS_CERT_PATH').trim();
  const caPath = config.get('API_TLS_CA_PATH').trim();
  const requireClientCertificate = config.bool('API_TLS_REQUIRE_CLIENT_CERT');
  const passphrase = config.get('API_TLS_KEY_PASSPHRASE');

  if (!keyPath && !certPath && !caPath && !requireClientCertificate && !passphrase) return undefined;
  if (!keyPath || !certPath) {
    throw new Error('Native API HTTPS requires both API_TLS_KEY_PATH and API_TLS_CERT_PATH');
  }
  if (requireClientCertificate && !caPath) {
    throw new Error('API_TLS_REQUIRE_CLIENT_CERT=true requires API_TLS_CA_PATH');
  }

  const options: ApiTlsOptions = {
    key: readPem(keyPath, 'API TLS private key'),
    cert: readPem(certPath, 'API TLS certificate'),
  };
  if (caPath) options.ca = readPem(caPath, 'API TLS client CA');

  if (passphrase) options.passphrase = passphrase;
  if (requireClientCertificate) {
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }
  return options;
}

function readPem(filePath: string, label: string) {
  const resolved = path.resolve(filePath);
  try {
    return fs.readFileSync(resolved);
  } catch (error: any) {
    throw new Error(`Unable to read ${label} at ${resolved}: ${error?.message || error}`);
  }
}
