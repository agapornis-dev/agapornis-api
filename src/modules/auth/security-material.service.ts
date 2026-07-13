import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { ApiConfigService } from '../../common/config/config.service';

interface SecurityMaterial {
  version: 1;
  userJwtSecret: string;
  twoFactorEncryptionKey: string;
  caKey: string;
  caCertificate: string;
  serverKey: string;
  serverCertificate: string;
}

const SECURITY_DOCUMENT = 'primary';
const SECURITY_TABLE = 'cluster_security';
const SECURITY_KEY_COLUMN = 'material_key';

@Injectable()
export class SecurityMaterialService implements OnModuleInit {
  private readonly logger = new Logger(SecurityMaterialService.name);
  private readonly keysDir: string;
  private initialization?: Promise<void>;
  private material?: SecurityMaterial;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ApiConfigService,
  ) {
    this.keysDir = this.config.get('KEYS_DIR', path.join(__dirname, '..', '..', 'keys'));
  }

  async onModuleInit() {
    await this.initialize();
  }

  initialize() {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }

  userJwtSecret() {
    return this.requireMaterial().userJwtSecret;
  }

  twoFactorKey() {
    return crypto
      .createHash('sha256')
      .update(this.requireMaterial().twoFactorEncryptionKey)
      .digest();
  }

  certificateBundle() {
    const material = this.requireMaterial();
    return {
      caKey: Buffer.from(material.caKey),
      caCertificate: Buffer.from(material.caCertificate),
      serverKey: Buffer.from(material.serverKey),
      serverCertificate: Buffer.from(material.serverCertificate),
    };
  }

  private async load() {
    await this.database.init();

    if (this.database.enabled) {
      const candidate = () => this.loadLocalDocument() || this.localCandidate();
      this.material = await this.loadShared() || await this.loadOrCreateShared(candidate());
      this.warnAboutIgnoredOverrides(this.material);
      this.materializeCertificates(this.material);
      this.logger.log('Loaded shared API and certificate keys from the database');
      return;
    }

    const candidate = this.loadLocalDocument() || this.localCandidate();
    this.material = candidate;
    this.writeLocalDocument(candidate);
    this.materializeCertificates(candidate);
    this.logger.warn('Using instance-local API and certificate keys; configure PostgreSQL or MySQL before running multiple API replicas');
  }

  private async loadShared() {
    const rows = await this.database.query(
      `SELECT value FROM ${SECURITY_TABLE} WHERE ${SECURITY_KEY_COLUMN} = ${this.database.placeholders(1)}`,
      [SECURITY_DOCUMENT],
    );
    return rows.length ? this.parse(rows[0].value) : undefined;
  }

  private async loadOrCreateShared(candidate: SecurityMaterial) {
    try {
      return await this.database.transaction(async tx => {
        await this.database.advisoryLock(tx, `${SECURITY_TABLE}:${SECURITY_DOCUMENT}`);
        const rows = await tx.query(
          `SELECT value FROM ${SECURITY_TABLE} WHERE ${SECURITY_KEY_COLUMN} = ${tx.placeholders(1)}`,
          [SECURITY_DOCUMENT],
        );
        if (rows.length) return this.parse(rows[0].value);

        await tx.query(
          `INSERT INTO ${SECURITY_TABLE} (${SECURITY_KEY_COLUMN}, value, updated_at) VALUES (${tx.placeholders(3)})`,
          [SECURITY_DOCUMENT, JSON.stringify(candidate), new Date().toISOString()],
        );
        return candidate;
      }, { isolation: 'SERIALIZABLE', retries: 3 });
    } catch (error) {
      if (!this.database.isUniqueViolation(error)) throw error;
      const rows = await this.database.query(
        `SELECT value FROM ${SECURITY_TABLE} WHERE ${SECURITY_KEY_COLUMN} = ${this.database.placeholders(1)}`,
        [SECURITY_DOCUMENT],
      );
      if (!rows.length) throw error;
      return this.parse(rows[0].value);
    }
  }

  private localCandidate(): SecurityMaterial {
    const certificates = this.readLocalCertificates() || this.generateCertificates();
    return {
      version: 1,
      userJwtSecret: this.configuredSecret('APP_JWT_SECRET') || crypto.randomBytes(48).toString('base64url'),
      twoFactorEncryptionKey: this.configuredSecret('TWO_FACTOR_ENCRYPTION_KEY')
        || this.configuredSecret('APP_JWT_SECRET')
        || this.readLegacyTwoFactorKey()
        || crypto.randomBytes(48).toString('base64url'),
      ...certificates,
    };
  }

  private readLocalCertificates(): Pick<SecurityMaterial, 'caKey' | 'caCertificate' | 'serverKey' | 'serverCertificate'> | undefined {
    const files = this.certificatePaths();
    const present = Object.values(files).filter(file => fs.existsSync(file));
    if (!present.length) return undefined;
    if (present.length !== Object.keys(files).length) {
      throw new Error(`Incomplete mTLS key material in ${this.keysDir}; restore or remove the partial certificate set before startup`);
    }
    return {
      caKey: fs.readFileSync(files.caKey, 'utf8'),
      caCertificate: fs.readFileSync(files.caCertificate, 'utf8'),
      serverKey: fs.readFileSync(files.serverKey, 'utf8'),
      serverCertificate: fs.readFileSync(files.serverCertificate, 'utf8'),
    };
  }

  private generateCertificates(): Pick<SecurityMaterial, 'caKey' | 'caCertificate' | 'serverKey' | 'serverCertificate'> {
    fs.mkdirSync(this.keysDir, { recursive: true });
    const workDir = fs.mkdtempSync(path.join(this.keysDir, '.bootstrap-'));
    const caKey = path.join(workDir, 'ca.key');
    const caCertificate = path.join(workDir, 'ca.crt');
    const serverKey = path.join(workDir, 'server.key');
    const serverCertificate = path.join(workDir, 'server.crt');
    const serverCsr = path.join(workDir, 'server.csr');
    const serverExt = path.join(workDir, 'server.ext');
    const caConf = path.join(workDir, 'ca.conf');

    try {
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
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:4096', '-days', '3650', '-nodes',
        '-keyout', caKey, '-out', caCertificate, '-config', caConf,
      ], { stdio: 'pipe' });
      execFileSync('openssl', [
        'req', '-newkey', 'rsa:3072', '-nodes',
        '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=agapornis-master',
      ], { stdio: 'pipe' });
      fs.writeFileSync(serverExt,
        'subjectAltName=DNS:agapornis-master,DNS:localhost,IP:127.0.0.1\n'
        + 'extendedKeyUsage=clientAuth,serverAuth\n');
      execFileSync('openssl', [
        'x509', '-req', '-days', '825', '-in', serverCsr,
        '-CA', caCertificate, '-CAkey', caKey,
        '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
        '-extfile', serverExt, '-out', serverCertificate,
      ], { stdio: 'pipe' });
      const certificate = new crypto.X509Certificate(fs.readFileSync(serverCertificate));
      if (!certificate.subjectAltName) throw new Error('server.crt was generated without SANs');
      return {
        caKey: fs.readFileSync(caKey, 'utf8'),
        caCertificate: fs.readFileSync(caCertificate, 'utf8'),
        serverKey: fs.readFileSync(serverKey, 'utf8'),
        serverCertificate: fs.readFileSync(serverCertificate, 'utf8'),
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  private materializeCertificates(material: SecurityMaterial) {
    fs.mkdirSync(this.keysDir, { recursive: true });
    const files = this.certificatePaths();
    this.writeSecret(files.caKey, material.caKey);
    this.writeSecret(files.caCertificate, material.caCertificate);
    this.writeSecret(files.serverKey, material.serverKey);
    this.writeSecret(files.serverCertificate, material.serverCertificate);
  }

  private writeSecret(file: string, value: string) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== value) {
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, value, { mode: 0o600 });
      try {
        fs.renameSync(temporary, file);
      } catch (error: any) {
        if (!fs.existsSync(file) || !['EEXIST', 'EPERM'].includes(String(error?.code || ''))) throw error;
        fs.unlinkSync(file);
        fs.renameSync(temporary, file);
      }
    }
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  }

  private certificatePaths() {
    return {
      caKey: path.join(this.keysDir, 'ca.key'),
      caCertificate: path.join(this.keysDir, 'ca.crt'),
      serverKey: path.join(this.keysDir, 'server.key'),
      serverCertificate: path.join(this.keysDir, 'server.crt'),
    };
  }

  private readLegacyTwoFactorKey() {
    const file = path.join(__dirname, '..', '..', 'data', 'two-factor.key');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
  }

  private loadLocalDocument() {
    const file = this.localDocumentPath();
    if (!fs.existsSync(file)) return undefined;
    return this.parse(fs.readFileSync(file, 'utf8'));
  }

  private writeLocalDocument(material: SecurityMaterial) {
    const file = this.localDocumentPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.writeSecret(file, JSON.stringify(material, null, 2));
  }

  private localDocumentPath() {
    return this.config.get('SECURITY_MATERIAL_FILE')
      || path.join(__dirname, '..', '..', 'data', 'security-material.json');
  }

  private configuredSecret(name: string) {
    const value = this.config.get(name);
    if (!value) return undefined;
    if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
    return value;
  }

  private parse(value: unknown): SecurityMaterial {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const material = parsed as Partial<SecurityMaterial>;
    const required: Array<keyof SecurityMaterial> = [
      'userJwtSecret', 'twoFactorEncryptionKey', 'caKey', 'caCertificate', 'serverKey', 'serverCertificate',
    ];
    if (material.version !== 1 || required.some(key => typeof material[key] !== 'string' || !material[key])) {
      throw new Error('The shared cluster security document is invalid');
    }
    return material as SecurityMaterial;
  }

  private warnAboutIgnoredOverrides(material: SecurityMaterial) {
    const jwt = this.config.get('APP_JWT_SECRET');
    if (jwt && jwt !== material.userJwtSecret) {
      this.logger.warn('APP_JWT_SECRET differs from the database security bundle; the shared database value is authoritative');
    }
    const twoFactor = this.config.get('TWO_FACTOR_ENCRYPTION_KEY');
    if (twoFactor && twoFactor !== material.twoFactorEncryptionKey) {
      this.logger.warn('TWO_FACTOR_ENCRYPTION_KEY differs from the database security bundle; the shared database value is authoritative');
    }
  }

  private requireMaterial() {
    if (!this.material) throw new Error('API security material has not finished initializing');
    return this.material;
  }
}
