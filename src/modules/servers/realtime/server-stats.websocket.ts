import * as crypto from 'crypto';
import { IncomingMessage, Server as HttpServer } from 'http';
import { Duplex } from 'stream';
import { AuthService } from '../../auth/auth.service';
import { UsersService } from '../../users/users.service';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerRealtimeService } from './server-realtime.service';
import { hasTrustedRequestOrigin } from '../../security/csrf.guard';

interface StatsWebSocketDeps {
  auth: AuthService;
  realtime: ServerRealtimeService;
  registry: ServerRegistryService;
  users: UsersService;
}

const STATS_PATH = /^\/api\/agents\/([^/]+)\/servers\/([^/]+)\/stats\/ws$/;
const PANEL_SESSION_COOKIE = 'agapornis_session';

export function installServerStatsWebSocket(server: HttpServer, deps: StatsWebSocketDeps) {
  server.on('upgrade', async (req, socket, head) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const match = parsed.pathname.match(STATS_PATH);
    if (!match) return;
    if (!hasTrustedRequestOrigin(req)) {
      rejectUpgrade(socket, 403, 'forbidden origin');
      return;
    }

    try {
      const nodeId = decodeURIComponent(match[1]);
      const serverId = decodeURIComponent(match[2]);
      const token = cookieValue(req.headers.cookie, PANEL_SESSION_COOKIE);
      const user = await authenticateUser(token, req, deps);
      const serverRecord = await deps.registry.get(serverId);

      if (!serverRecord || serverRecord.nodeId !== nodeId || !deps.registry.canAccess(serverRecord, user)) {
        rejectUpgrade(socket, 404, 'server not found');
        return;
      }

      acceptUpgrade(req, socket, head);
      startStatsStream(socket, nodeId, serverId, deps);
    } catch {
      rejectUpgrade(socket, 401, 'unauthorized');
    }
  });
}

async function authenticateUser(token: string, req: IncomingMessage, deps: StatsWebSocketDeps) {
  if (!token) throw new Error('token required');

  const payload = deps.auth.verifyUserToken(token) as any;
  const user = await deps.users.findByIdForAuth(payload.sub);
  if (!user) throw new Error('user not found');
  if (Number(payload.ver || 0) !== Number(user.sessionVersion || 0)) throw new Error('session revoked');

  const publicUser = deps.users.publicUser(user);
  deps.auth.enforceAccess(publicUser, req);
  deps.auth.enforceMaintenance(publicUser.role);
  return publicUser;
}

function cookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return '';
  for (const cookie of String(cookieHeader).split(';')) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }

  return '';
}

function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const key = req.headers['sec-websocket-key'];
  if (!key) throw new Error('websocket key required');

  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  if (head.length) socket.unshift(head);
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function startStatsStream(socket: Duplex, nodeId: string, serverId: string, deps: StatsWebSocketDeps) {
  let closed = false;
  let unsubscribe = () => {};

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    socket.destroy();
  };

  socket.on('close', close);
  socket.on('error', close);
  socket.on('end', close);
  socket.on('data', chunk => {
    const opcode = Buffer.isBuffer(chunk) ? chunk[0] & 0x0f : 0;
    if (opcode === 0x8) close();
    if (opcode === 0x9) sendFrame(socket, Buffer.alloc(0), 0x8a);
  });

  unsubscribe = deps.realtime.subscribeStats(nodeId, serverId, message => {
    if (closed || socket.destroyed) return;
    sendJson(socket, message.payload);
  });
}

function sendJson(socket: Duplex, value: any) {
  sendFrame(socket, Buffer.from(JSON.stringify(value), 'utf8'), 0x81);
}

function sendFrame(socket: Duplex, payload: Buffer, firstByte: number) {
  if (socket.destroyed) return;

  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.from([firstByte, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}
