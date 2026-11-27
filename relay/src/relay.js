// Rocket Rumble relay.
//
// A go-between for two browsers that cannot reach each other directly. Each room is one Durable
// Object holding up to two WebSocket connections; every message a player sends is handed to the
// other player unchanged. The relay knows nothing about the game: the host's browser stays the
// only authority on what happens in a match.
//
//   GET  /        health check
//   WS   /ws?room=123456&role=host|guest
//
// A closed connection carries one of CLOSE as its code, which the game turns into a message.

const ROOM_CODE = /^\d{6}$/;
const MAX_PLAYERS = 2;
const MAX_MESSAGE_CHARS = 64 * 1024;
// A player sends about 35 messages a second in play; anything far above that is not the game.
const MESSAGE_BUDGET = 240;
const WINDOW_MS = 1000;

export const CLOSE = {
  NO_ROOM: 4000,
  FULL: 4001,
  TOO_LARGE: 4002,
  TOO_FAST: 4003,
  PEER_LEFT: 4004,
  ORIGIN: 4005,
};

// The handshake has already succeeded by the time a Worker can answer, so a refusal is an
// accepted socket that is closed at once with the reason as its code.
function refuse(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'host' && role !== 'guest') return refuse(CLOSE.ORIGIN, 'unknown role');

    const present = this.ctx.getWebSockets().map(socket => socket.deserializeAttachment());
    if (present.length >= MAX_PLAYERS) return refuse(CLOSE.FULL, 'room is full');
    if (role === 'host' && present.some(player => player.role === 'host')) {
      return refuse(CLOSE.FULL, 'room already has a host');
    }
    // A guest may only join a room whose host is connected, so a mistyped code fails at once.
    if (role === 'guest' && !present.some(player => player.role === 'host')) {
      return refuse(CLOSE.NO_ROOM, 'room not found');
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, count: 0, since: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) {
      socket.close(CLOSE.TOO_LARGE, 'message too large');
      return;
    }
    const player = socket.deserializeAttachment();
    const time = Date.now();
    if (time - player.since > WINDOW_MS) {
      player.since = time;
      player.count = 0;
    }
    if (++player.count > MESSAGE_BUDGET) {
      socket.close(CLOSE.TOO_FAST, 'too many messages');
      return;
    }
    socket.serializeAttachment(player);

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (!data || typeof data.type !== 'string') return;
    for (const other of this.ctx.getWebSockets()) {
      if (other === socket) continue;
      try {
        other.send(message);
      } catch {
        // A closing socket is cleaned up by its own close event.
      }
    }
  }

  webSocketClose(socket) {
    // The game has its own timeouts, but nobody should wait for them once a player is gone.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket) other.close(CLOSE.PEER_LEFT, 'the other player left');
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response('Rocket Rumble relay is running\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    // Optional lock-down: a comma-separated list of sites allowed to connect, set as a variable.
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(request.headers.get('Origin'))) {
      return new Response('Origin not allowed', { status: 403 });
    }
    const room = (url.searchParams.get('room') || '').trim();
    if (!ROOM_CODE.test(room)) return new Response('Room code must be six digits', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};
