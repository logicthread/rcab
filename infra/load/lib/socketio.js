/**
 * Minimal Socket.IO v4 (Engine.IO v4, websocket transport) client over k6's `k6/ws`.
 *
 * Only what the driver workloads need: connect to the default namespace with `{ token }` auth,
 * answer Engine.IO pings, receive events, emit events with an optional ack callback.
 *
 * Wire format (https://socket.io/docs/v4/socket-io-protocol/):
 *   0{...}            Engine.IO open (server)        2 / 3     ping / pong
 *   40{auth} / 40{..} namespace connect / connected  41        namespace disconnected (e.g. bad token)
 *   42<id>[ev,data]   event, optional ack id         43<id>[a] ack
 */
import ws from 'k6/ws';
import { wsUrl } from './config.js';

/**
 * Run one socket session (blocks until it closes).
 *
 * @param {string} base      API base, e.g. http://localhost:3000
 * @param {string} token     access token (handshake auth)
 * @param {object} h         handlers
 * @param {(c: Client) => void}                         h.onReady    namespace connected
 * @param {(name: string, data: any, c: Client) => void} h.onEvent    server event
 * @param {(reason: string) => void}                    [h.onClose]  closed / disconnected
 * @returns {{ status: number }} the websocket upgrade response
 */
export function session(base, token, h) {
  return ws.connect(wsUrl(base), {}, (socket) => {
    let ackSeq = 0;
    const acks = {};
    let ready = false;

    const client = {
      socket,
      get ready() {
        return ready;
      },
      emit(name, data, ack) {
        let id = '';
        if (ack) {
          id = String(++ackSeq);
          acks[id] = ack;
        }
        socket.send('42' + id + JSON.stringify([name, data]));
      },
      close() {
        socket.close();
      },
    };

    socket.on('message', (msg) => {
      if (msg === '2') {
        socket.send('3');
      } else if (msg.charAt(0) === '0') {
        socket.send('40' + JSON.stringify({ token }));
      } else if (msg.indexOf('40') === 0) {
        ready = true;
        if (h.onReady) h.onReady(client);
      } else if (msg.indexOf('41') === 0) {
        ready = false;
        if (h.onClose) h.onClose('namespace_disconnected');
        socket.close();
      } else if (msg.indexOf('42') === 0) {
        const m = /^42(\d*)(\[[\s\S]*\])$/.exec(msg);
        if (!m) return;
        const arr = JSON.parse(m[2]);
        if (h.onEvent) h.onEvent(arr[0], arr[1], client);
      } else if (msg.indexOf('43') === 0) {
        const m = /^43(\d+)(\[[\s\S]*\])$/.exec(msg);
        if (!m) return;
        const cb = acks[m[1]];
        delete acks[m[1]];
        if (cb) cb(JSON.parse(m[2])[0]);
      }
    });
    socket.on('close', () => {
      if (h.onClose) h.onClose('closed');
    });
    socket.on('error', () => {
      if (h.onClose) h.onClose('error');
    });

    if (h.onOpen) h.onOpen(client);
  });
}
