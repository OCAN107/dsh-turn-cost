/**
 * dsh-turn-cost — host half.
 *
 * Folds every `assistant/message` usage into a per-turn accumulator, then
 * exposes it over one POST route so the browser half can ask "what did this
 * message's turn cost?" by message id.
 *
 * On boot it also backfills from the on-disk session logs, so turns recorded
 * before this plugin was installed still get a price.
 *
 * Pricing is the DeepSeek published rate per one million tokens, in CNY.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'dsh-turn-cost';

const LOG = 'C:/Users/13554/.dsh/plugins/dsh-turn-cost/loaded.log';

/** CNY per 1M tokens. */
const PRICES = {
  uncachedInput: 2.0,
  cacheRead: 0.2,
  cacheWrite: 2.0,
  output: 3.0,
};

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function mark(line) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {}
}

function costOf(acc) {
  return (
    acc.uncachedInput * PRICES.uncachedInput +
    acc.cacheRead * PRICES.cacheRead +
    acc.cacheWrite * PRICES.cacheWrite +
    acc.output * PRICES.output
  ) / 1e6;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Session logs are many zstd frames back to back; Node only inflates the first. */
function inflateAll(buf) {
  const offsets = [];
  let cursor = 0;
  while (true) {
    const at = buf.indexOf(MAGIC, cursor);
    if (at === -1) break;
    offsets.push(at);
    cursor = at + 4;
  }
  const parts = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)));
    } catch {}
  }
  return Buffer.concat(parts).toString('utf8');
}

function walkSessionLogs(dir, out, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSessionLogs(path, out, depth + 1);
    } else if (entry.name === 'session.v4.jsonl.zstd') {
      out.push(path);
    }
  }
}

export function apply(ctx) {
  mark('apply: entered (reload probe)');
  // Diagnostic: is this plugin's client half actually in the boot graph?
  // `bundle-executed` in the log proves the browser executed the bundle;
  // a table listing proves the Node half composed a graph row for it.
  try {
    let seen = false;
    ctx.inject(['clientModules'], (scope) => {
      seen = true;
      try {
        const reg = (scope && typeof scope.get === 'function' ? scope.get('clientModules') : undefined) ?? scope?.clientModules;
        const keys = (value) => {
          try {
            if (value && typeof value.keys === 'function') return [...value.keys()];
            if (value && typeof value !== 'object') return [];
            return Object.keys(value);
          } catch {
            return ['<unreadable>'];
          }
        };
        mark(
          `clientModules: table=${JSON.stringify(keys(reg && reg.table))} sources=${JSON.stringify(keys(reg && reg.sources))} pkgMeta=${JSON.stringify(keys(reg && reg.pkgMeta))}`,
        );
      } catch (error) {
        mark(`clientModules inspect failed: ${error?.message ?? String(error)}`);
      }
    });
    setTimeout(() => {
      if (!seen) mark('clientModules: inject callback NEVER fired');
    }, 8000);
  } catch (error) {
    mark(`clientModules inject failed: ${error?.message ?? String(error)}`);
  }

  // sessionId -> turn -> accumulated token buckets
  const turns = new Map();
  // messageId -> { sessionId, turn }
  const messageToTurn = new Map();
  let routeHits = 0;

  function record(sessionId, messageId, turn, usage) {
    if (typeof sessionId !== 'string' || typeof messageId !== 'string') return;
    if (typeof turn !== 'number' || !usage || typeof usage !== 'object') return;
    let byTurn = turns.get(sessionId);
    if (byTurn === undefined) {
      byTurn = new Map();
      turns.set(sessionId, byTurn);
    }
    let acc = byTurn.get(turn);
    if (acc === undefined) {
      acc = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      byTurn.set(turn, acc);
    }
    acc.uncachedInput += num(usage.inputTokens);
    acc.cacheRead += num(usage.cacheReadTokens);
    acc.cacheWrite += num(usage.cacheWriteTokens);
    acc.output += num(usage.outputTokens);
    messageToTurn.set(messageId, { sessionId, turn });
    if (messageToTurn.size > 50000) {
      const first = messageToTurn.keys().next();
      if (!first.done) messageToTurn.delete(first.value);
    }
  }

  function advance(sessionId, event) {
    if (!event || event.type !== 'assistant/message') return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const messageId = data.message && data.message.id;
    record(sessionId, messageId, data.turn, data.usage);
  }

  function backfill() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const root = join(home, 'sessions');
    const files = [];
    walkSessionLogs(root, files, 0);
    let events = 0;
    for (const file of files) {
      try {
        const text = inflateAll(readFileSync(file));
        const sessionId = dirname(file).split(/[\\/]/).pop() ?? '';
        for (const line of text.split('\n')) {
          if (line === '' || line.indexOf('assistant/message') === -1) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type !== 'assistant/message') continue;
          const data = event.data;
          if (!data || !data.message) continue;
          record(sessionId, data.message.id, data.turn, data.usage);
          events += 1;
        }
      } catch {}
    }
    mark(`backfill: ${files.length} logs, ${events} events, ${messageToTurn.size} messages`);
  }

  try {
    ctx.on('session/event', (session, event) => {
      if (!session || typeof session.id !== 'string') return;
      advance(session.id, event);
    });
    mark('apply: session/event subscribed');
  } catch (error) {
    mark(`apply: session/event failed: ${error?.message ?? String(error)}`);
  }

  // Never block boot; the badge retries for a couple of seconds anyway.
  setTimeout(() => {
    try {
      backfill();
    } catch (error) {
      mark(`backfill failed: ${error?.message ?? String(error)}`);
    }
  }, 0);

  try {
    ctx.inject(['connection'], (scope) => {
      const connection = scope.get('connection');
      const register =
        connection && connection.fetch && typeof connection.fetch.register === 'function'
          ? connection.fetch.register.bind(connection.fetch)
          : undefined;
      if (register === undefined) {
        mark('apply: connection.fetch.register unavailable');
        return;
      }
      const dispose = register({
        path: '/api/dsh-turn-cost',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          routeHits += 1;
          if (routeHits <= 5) mark(`route hit #${routeHits}`);
          let body = {};
          try {
            body = await request.json();
          } catch {
            body = {};
          }
          // Two request shapes share this route:
          //   { messageIds: [...] } — newest turns, keyed by assistant message id
          //   { sessionId }         — one whole session's per-turn cost table,
          //                           needed by the turn-tail badge because old
          //                           turns carry no rendered message id at all
          if (typeof body?.sessionId === 'string') {
            const sessionId = body.sessionId;
            const table = turns.get(sessionId);
            const out = {};
            if (table !== undefined) {
              for (const [turn, acc] of table) out[String(turn)] = costOf(acc);
            }
            mark(`session request: ${sessionId} turns=${Object.keys(out).length}`);
            return Response.json(
              { ok: true, sessionId, turns: out },
              { headers: { 'cache-control': 'no-store' } },
            );
          }
          const ids = Array.isArray(body?.messageIds) ? body.messageIds : [];
          const value = {};
          for (const id of ids) {
            if (typeof id !== 'string') continue;
            const ref = messageToTurn.get(id);
            if (ref === undefined) continue;
            const acc = turns.get(ref.sessionId)?.get(ref.turn);
            if (acc === undefined) continue;
            value[id] = { turn: ref.turn, cost: costOf(acc), tokens: { ...acc } };
          }
          return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } });
        },
      });
      mark('apply: route registered');
      let reportDispose;
      try {
        reportDispose = register({
          path: '/api/dsh-turn-cost/report',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            mark(`client report: ${JSON.stringify(body).slice(0, 400)}`);
            return Response.json({ ok: true });
          },
        });
        mark('apply: report route registered');
      } catch (error) {
        mark(`apply: report route failed: ${error?.message ?? String(error)}`);
      }
      // Post-boot self check: read the connection's own route table a moment
      // later. A path present here means the HTTP layer really holds the route,
      // so a browser 404 afterwards would point somewhere else entirely.
      setTimeout(() => {
        try {
          const current = scope.get('connection');
          const table = current && current.fetchRoutes;
          if (table && typeof table.keys === 'function') {
            const mine = [...table.keys()].filter((key) => String(key).includes('turn-cost'));
            mark(`routes probe: ${JSON.stringify(mine)} (total ${table.size})`);
            if (mine.length === 0) mark('routes probe: MISSING — registration was undone');
          } else {
            mark('routes probe: fetchRoutes not readable');
          }
        } catch (error) {
          mark(`routes probe failed: ${error?.message ?? String(error)}`);
        }
      }, 2500);

      // `register` already wraps the route in the owning Context's effect, so it
      // lives as long as this plugin. Dispose explicitly only on unload: the
      // effect body must RETURN the cleanup, never call it inline — calling it
      // inline unregistered both routes immediately, which is why the browser
      // saw HTTP 404 while the log said "route registered".
      if (typeof scope.effect === 'function') {
        scope.effect(
          () => () => {
            if (typeof dispose === 'function') dispose();
            if (typeof reportDispose === 'function') reportDispose();
          },
          'dsh-turn-cost: routes',
        );
      }
    });
  } catch (error) {
    mark(`apply: route failed: ${error?.message ?? String(error)}`);
  }
}
