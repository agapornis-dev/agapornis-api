require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const {
  configuredBrowserOrigins,
  installBrowserSecurity,
  normalizeOrigin,
} = require('../src/modules/security/browser-security');
const {
  CsrfGuard,
  hasTrustedRequestOrigin,
  requestOrigin,
  requiresCsrfValidation,
} = require('../src/modules/security/csrf.guard');
const { PUBLIC_ROUTE_KEY } = require('../src/modules/security/public.decorator');
const { APP_GUARD } = require('@nestjs/core');
const { AuthController } = require('../src/modules/auth/auth.controller');
const { AuthModule } = require('../src/modules/auth/auth.module');
const { SystemHealthController } = require('../src/modules/system-updates/system-health.controller');
const { PanelSettingsController } = require('../src/modules/settings/panel-settings.controller');

function contextFor(request) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

async function main() {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    cors: process.env.CORS_ALLOWED_ORIGINS,
    panel: process.env.PANEL_PUBLIC_URL,
  };
  process.env.NODE_ENV = 'production';
  process.env.CORS_ALLOWED_ORIGINS = 'https://panel.example, https://admin.example/path';
  delete process.env.PANEL_PUBLIC_URL;

  try {
    assert.equal(normalizeOrigin('https://panel.example/path'), 'https://panel.example');
    assert.equal(normalizeOrigin('javascript:alert(1)'), '');
    assert.deepEqual(configuredBrowserOrigins(), [
      'https://panel.example',
      'https://admin.example',
    ]);

    assert.equal(requiresCsrfValidation({ method: 'GET', headers: {} }), false);
    assert.equal(requiresCsrfValidation({
      method: 'POST',
      headers: { authorization: 'Bearer token', cookie: 'agapornis_session=session' },
    }), false);
    assert.equal(requiresCsrfValidation({
      method: 'POST',
      headers: { cookie: 'other=value' },
    }), false);
    assert.equal(requiresCsrfValidation({
      method: 'POST',
      headers: { cookie: 'agapornis_session=session' },
    }), true);
    assert.equal(
      requestOrigin({ headers: { referer: 'https://panel.example/settings' } }),
      'https://panel.example',
    );
    assert.equal(hasTrustedRequestOrigin({
      protocol: 'https',
      headers: { host: 'api.example', origin: 'https://api.example' },
    }), true);
    assert.equal(hasTrustedRequestOrigin({
      protocol: 'https',
      headers: { host: 'api.example', origin: 'https://attacker.example' },
    }), false);

    const csrf = new CsrfGuard();
    assert.equal(csrf.canActivate(contextFor({
      method: 'PATCH',
      protocol: 'https',
      headers: {
        cookie: 'agapornis_session=session',
        host: 'api.example',
        origin: 'https://panel.example',
      },
    })), true);
    assert.equal(csrf.canActivate(contextFor({
      method: 'DELETE',
      protocol: 'https',
      headers: {
        cookie: 'agapornis_session=session',
        host: 'api.example',
        origin: 'https://api.example',
      },
    })), true);
    assert.throws(() => csrf.canActivate(contextFor({
      method: 'POST',
      protocol: 'https',
      headers: {
        cookie: 'agapornis_session=session',
        host: 'api.example',
        origin: 'https://attacker.example',
      },
    })), /CSRF origin validation failed/);

    let corsOptions;
    let sendHook;
    const app = {
      enableCors: options => { corsOptions = options; },
      getHttpAdapter: () => ({
        getInstance: () => ({
          addHook: (name, hook) => {
            assert.equal(name, 'onSend');
            sendHook = hook;
          },
        }),
      }),
    };
    installBrowserSecurity(app);

    await new Promise((resolve, reject) => {
      corsOptions.origin('https://panel.example', (error, allowed) => {
        try {
          assert.ifError(error);
          assert.equal(allowed, true);
          resolve();
        } catch (assertion) {
          reject(assertion);
        }
      });
    });
    await new Promise(resolve => {
      corsOptions.origin('https://attacker.example', (error, allowed) => {
        assert.ifError(error);
        assert.equal(allowed, false);
        resolve();
      });
    });

    const headers = {};
    await sendHook({}, { header: (name, value) => { headers[name] = value; } }, {});
    assert.match(headers['Content-Security-Policy'], /default-src 'none'/);
    assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
    assert.equal(headers['X-XSS-Protection'], '0');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');

    const healthHandler = Object.getOwnPropertyDescriptor(
      SystemHealthController.prototype,
      'status',
    ).value;
    const publicSettingsHandler = Object.getOwnPropertyDescriptor(
      PanelSettingsController.prototype,
      'publicSettings',
    ).value;
    assert.equal(Reflect.getMetadata(PUBLIC_ROUTE_KEY, healthHandler), true);
    assert.equal(Reflect.getMetadata(PUBLIC_ROUTE_KEY, publicSettingsHandler), true);
    assert.equal(
      Reflect.getMetadata(
        PUBLIC_ROUTE_KEY,
        Object.getOwnPropertyDescriptor(AuthController.prototype, 'login').value,
      ),
      true,
    );
    assert.notEqual(
      Reflect.getMetadata(
        PUBLIC_ROUTE_KEY,
        Object.getOwnPropertyDescriptor(AuthController.prototype, 'me').value,
      ),
      true,
    );
    const globalGuards = Reflect.getMetadata('providers', AuthModule)
      .filter(provider => provider?.provide === APP_GUARD);
    assert.equal(globalGuards.length, 3);

    console.log('http security tests: PASS');
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.cors === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous.cors;
    if (previous.panel === undefined) delete process.env.PANEL_PUBLIC_URL;
    else process.env.PANEL_PUBLIC_URL = previous.panel;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
