import { Inject, Injectable, Logger, OnModuleInit, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { isIP } from 'net';
import { PanelSettingsService } from '../settings/panel-settings.service';
import { BansService } from '../bans/bans.service';
import { SecurityMaterialService } from './security-material.service';
import { ApiConfigService } from '../../common/config/config.service';

const jwt = require('jsonwebtoken');
const JWT_ALGORITHM = 'HS512';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly keysDir: string;

  constructor(
    @Inject(forwardRef(() => PanelSettingsService))
    private readonly panelSettings: PanelSettingsService,
    @Inject(forwardRef(() => BansService))
    private readonly bans: BansService,
    private readonly securityMaterial: SecurityMaterialService,
    private readonly config: ApiConfigService,
  ) {
    this.keysDir = this.config.get('KEYS_DIR', path.join(__dirname, '..', '..', 'keys'));
  }

  enforceMaintenance(role: string | undefined) {
    this.panelSettings.enforceMaintenance(role);
  }

  enforceAccess(user: { id?: string; email?: string }, req: any) {
    this.bans.assertAllowed({ userId: user.id, email: user.email, ip: this.bans.requestIp(req) });
  }

  async onModuleInit() {
    await this.securityMaterial.initialize();
  }

  // ==========================================
  // mTLS INFRASTRUCTURE & PROVISIONING
  // ==========================================

  private ensureMTLSCertificates() {
      fs.mkdirSync(this.keysDir, { recursive: true });

      const caKey     = path.join(this.keysDir, 'ca.key');
      const caCrt     = path.join(this.keysDir, 'ca.crt');
      const serverKey = path.join(this.keysDir, 'server.key');
      const serverCrt = path.join(this.keysDir, 'server.crt');

      const certificateFiles = [caKey, caCrt, serverKey, serverCrt];
      const existingFiles = certificateFiles.filter(file => fs.existsSync(file));
      if (existingFiles.length === certificateFiles.length) return;
      if (existingFiles.length > 0) {
        throw new Error(`Incomplete mTLS key material in ${this.keysDir}; restore or remove the partial certificate set before startup`);
      }

      console.log('Generating private CA and Master mTLS certificates...');

      const serverCsr = path.join(this.keysDir, 'server.csr');
      const serverExt = path.join(this.keysDir, 'server.ext');
      const caConf    = path.join(this.keysDir, 'ca.conf');

      try {
        // Write a full OpenSSL config for the CA cert (avoids any prompt issues)
        fs.writeFileSync(caConf, [
          '[req]',
          'prompt             = no',
          'distinguished_name = dn',
          'x509_extensions    = v3_ca',
          '[dn]',
          'CN = Agapornis-CA',
          '[v3_ca]',
          'subjectKeyIdentifier   = hash',
          'authorityKeyIdentifier = keyid:always,issuer',
          'basicConstraints       = critical,CA:true',
          'keyUsage               = critical,keyCertSign,cRLSign',
        ].join('\n'));

        // 1. Generate CA key + self-signed cert using config file (no pipe)
        execFileSync('openssl', [
          'req', '-x509', '-newkey', 'rsa:4096', '-days', '3650', '-nodes',
          '-keyout', caKey, '-out', caCrt, '-config', caConf
        ], { stdio: 'pipe' });

        // 2. Generate server key + CSR (no pipe, no extfile yet)
        execFileSync('openssl', [
          'req', '-newkey', 'rsa:3072', '-nodes',
          '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=agapornis-master'
        ], { stdio: 'pipe' });

        // 3. Write SAN ext file explicitly — one line, no section header needed for -extfile
        fs.writeFileSync(serverExt,
          'subjectAltName=DNS:agapornis-master,DNS:localhost,IP:127.0.0.1\n' +
          'extendedKeyUsage=clientAuth,serverAuth\n'
        );

        // 4. Sign server CSR with CA, injecting SANs — no pipe, just files
        execFileSync('openssl', [
          'x509', '-req', '-days', '825', '-in', serverCsr,
          '-CA', caCrt, '-CAkey', caKey, '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
          '-extfile', serverExt, '-out', serverCrt
        ], { stdio: 'pipe' });

        // 5. Verify the result before cleaning up
        const verify = execFileSync('openssl', ['x509', '-noout', '-text', '-in', serverCrt], { stdio: 'pipe' }).toString();

        if (!verify.includes('Subject Alternative Name')) {
          throw new Error('server.crt was generated without SANs — openssl extfile was ignored');
        }

        console.log('[mTLS] server.crt SANs verified successfully');

        this.lockFile(caKey);
        this.lockFile(serverKey);
        console.log(`mTLS certificates generated in ${this.keysDir}`);
      } catch (error) {
        this.logger.error('Failed to generate mTLS certificates.', error instanceof Error ? error.stack : String(error));
        throw error;
      } finally {
        // Always clean up temp files even on failure
        for (const f of [serverCsr, serverExt, caConf]) {
          try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
      }
    }

  /**
   * Generates a new mTLS client certificate for an Agent node.
   * Call this from your provisioning endpoint.
   */
    provisionAgentCertificate(nodeId: string, fqdn?: string) {
  this.validateNodeIdentity(nodeId, fqdn);
  const caKey = path.join(this.keysDir, 'ca.key');
  const caCrt = path.join(this.keysDir, 'ca.crt');

  if (!fs.existsSync(caCrt) || !fs.existsSync(caKey)) {
    throw new Error('Root CA not found. Cannot issue agent certificates.');
  }

  const workDir = fs.mkdtempSync(path.join(this.keysDir, '.issue-'));
  const agentKeyPath = path.join(workDir, 'agent.key');
  const agentCsrPath = path.join(workDir, 'agent.csr');
  const agentCrtPath = path.join(workDir, 'agent.crt');
  const agentExtPath = path.join(workDir, 'agent.ext');
  const serial = `0x${crypto.randomBytes(16).toString('hex')}`;

  // Build SAN list
  const sanEntries: string[] = [`DNS:${nodeId}`];
  if (fqdn) {
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(fqdn);
    sanEntries.push(isIp ? `IP:${fqdn}` : `DNS:${fqdn}`);
  }
  try {
    // 1. Generate agent key + CSR — no pipe
    execFileSync('openssl', [
      'req', '-newkey', 'rsa:3072', '-nodes',
      '-keyout', agentKeyPath, '-out', agentCsrPath, '-subj', `/CN=${nodeId}`
    ], { stdio: 'pipe' });

    // 2. Write ext file as raw lines (no section header)
    fs.writeFileSync(agentExtPath,
      `subjectAltName=${sanEntries.join(',')}\n` +
      `extendedKeyUsage=serverAuth,clientAuth\n`
    );

    // 3. Sign — no pipe, all named files
    execFileSync('openssl', [
      'x509', '-req', '-days', '365', '-in', agentCsrPath,
      '-CA', caCrt, '-CAkey', caKey, '-set_serial', serial,
      '-extfile', agentExtPath, '-out', agentCrtPath
    ], { stdio: 'pipe' });

    // 4. Verify SANs were embedded
    const verify = execFileSync('openssl', ['x509', '-noout', '-text', '-in', agentCrtPath], { stdio: 'pipe' }).toString();

    if (!verify.includes('Subject Alternative Name')) {
      throw new Error(`Agent cert for ${nodeId} was generated without SANs`);
    }

    const agentKey     = fs.readFileSync(agentKeyPath, 'utf8');
    const agentCrt     = fs.readFileSync(agentCrtPath, 'utf8');
    const caCrtContent = fs.readFileSync(caCrt, 'utf8');
    const certificate = new crypto.X509Certificate(agentCrt);

    console.log(`[provision] Agent cert issued for ${nodeId}, SANs: ${sanEntries.join(', ')}`);

    return {
      key: agentKey,
      cert: agentCrt,
      ca: caCrtContent,
      fingerprint: certificate.fingerprint256.replace(/:/g, '').toLowerCase(),
      serialNumber: certificate.serialNumber.toLowerCase(),
      expiresAt: new Date(certificate.validTo).toISOString()
    };
  } catch (error) {
    this.logger.error(`Provisioning failed for node ${nodeId}`, error instanceof Error ? error.stack : String(error));
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}


  // ==========================================
  // USER JWT LOGIC (Admin Panel / API)
  // ==========================================

  signForUser(user: { id: string; email: string; role: string; sessionVersion?: number }) {
    return jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.sessionVersion || 0,
      jti: crypto.randomUUID(),
      scope: 'panel'
    }, this.securityMaterial.userJwtSecret(), {
      algorithm: JWT_ALGORITHM,
      expiresIn: this.config.get('APP_JWT_EXPIRES_IN', '8h'),
      issuer: 'agapornis-master',
      audience: 'agapornis-panel'
    });
  }

  verifyUserToken(token: string) {
    return jwt.verify(token, this.securityMaterial.userJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
      issuer: 'agapornis-master',
      audience: 'agapornis-panel'
    });
  }

  signTwoFactorLoginChallenge(userId: string, sessionVersion: number) {
    return this.signPurposeToken({ sub: userId, ver: sessionVersion }, 'two-factor-login', '5m');
  }

  verifyTwoFactorLoginChallenge(token: string) {
    return this.verifyPurposeToken(token, 'two-factor-login');
  }

  signTwoFactorSetup(userId: string, sessionVersion: number, encryptedSecret: string) {
    return this.signPurposeToken({ sub: userId, ver: sessionVersion, encryptedSecret }, 'two-factor-setup', '10m');
  }

  verifyTwoFactorSetup(token: string) {
    return this.verifyPurposeToken(token, 'two-factor-setup');
  }

  signEmailVerification(userId: string, sessionVersion: number, email: string) {
    return this.signPurposeToken({ sub: userId, ver: sessionVersion, email }, 'email-verification', '24h');
  }

  verifyEmailVerification(token: string) {
    return this.verifyPurposeToken(token, 'email-verification');
  }

  private signPurposeToken(payload: Record<string, any>, purpose: string, expiresIn: string) {
    return jwt.sign({ ...payload, purpose, jti: crypto.randomUUID() }, this.securityMaterial.userJwtSecret(), {
      algorithm: JWT_ALGORITHM,
      expiresIn,
      issuer: 'agapornis-master',
      audience: 'agapornis-auth-challenge'
    });
  }

  private verifyPurposeToken(token: string, purpose: string) {
    const payload = jwt.verify(token, this.securityMaterial.userJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
      issuer: 'agapornis-master',
      audience: 'agapornis-auth-challenge'
    }) as any;
    if (payload?.purpose !== purpose || !payload?.sub) throw new Error('invalid authentication challenge');
    return payload;
  }

  private lockFile(filePath: string) {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
  }

  private validateNodeIdentity(nodeId: string, fqdn?: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(nodeId)) {
      throw new Error('nodeId may only contain letters, numbers, dots, underscores, and hyphens');
    }
    if (!fqdn) return;
    const validHostname = fqdn.length <= 253
      && fqdn.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
    if (!isIP(fqdn) && !validHostname) throw new Error('invalid agent FQDN or IP address');
  }
}
