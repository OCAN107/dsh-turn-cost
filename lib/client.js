/**
 * dsh-turn-cost — browser half.
 *
 * Registers one extra assistant-actions entry per turn tail. The host half
 * answers `/api/dsh-turn-cost` with the billed cost of the turn that a given
 * assistant message closed, and the badge renders it as `0.03🐟` after the
 * clock. `order: 99` wins inside the flex action row, so the badge lands to
 * the right of the timestamp instead of beside the copy button.
 *
 * Boot safety: the whole body runs inside try/catch and never throws during
 * plugin activation, so a rendering problem can only cost the badge, never the
 * shell. Diagnostics land on window.__dshTurnCost.
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-cost',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const state = { status: 'loading', error: null, registered: false, requests: 0 };
    try {
      window.__dshTurnCost = state;
    } catch {}

    // Boot beacon: proves this bundle actually executed in the page, even if
    // `apply` is never called (inject pending, slot missing, or a throw).
    try {
      const beaconBody = JSON.stringify({
        status: 'bundle-executed',
        href: typeof location !== 'undefined' ? String(location.href).slice(0, 160) : '',
        origin: typeof location !== 'undefined' ? String(location.origin).slice(0, 80) : '',
      });
      const beaconUrl = '/api/dsh-turn-cost/report';
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(beaconUrl, new Blob([beaconBody], { type: 'application/json' }));
      }
      fetch(beaconUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: beaconBody,
      }).catch(() => {});
    } catch {}

    let react;
    let jsx;
    let badge = null;
    let tail = null;
    try {
      react = require('react');
      jsx = require('react/jsx-runtime').jsx;
      state.status = 'modules';
    } catch (error) {
      state.status = 'modules-failed';
      state.error = error instanceof Error ? error.message : String(error);
    }

    if (react !== undefined && jsx !== undefined) {
      /** messageId -> number (only positive costs are cached) */
      const cache = new Map();
      /** messageId -> Set<setState> */
      const waiters = new Map();
      /** messageIds waiting for the next flush */
      const queue = new Set();
      let timer = null;

      function settle(id, value) {
        const set = waiters.get(id);
        if (set === undefined) return;
        waiters.delete(id);
        for (const fn of set) fn(value);
      }

      function schedule() {
        if (timer !== null) return;
        timer = setTimeout(flush, 60);
      }

      async function flush() {
        timer = null;
        const ids = [...queue];
        queue.clear();
        if (ids.length === 0) return;
        state.requests += 1;
        try {
          const response = await fetch('/api/dsh-turn-cost', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ messageIds: ids }),
          });
          state.httpStatus = response.status;
          if (!response.ok) {
            state.lastError = `HTTP ${response.status}`;
            for (const id of ids) settle(id, null);
            return;
          }
          state.lastError = null;
          const json = await response.json();
          const value = json && typeof json === 'object' ? json.value : undefined;
          for (const id of ids) {
            const entry = value && typeof value === 'object' ? value[id] : undefined;
            const cost = entry && typeof entry.cost === 'number' && entry.cost > 0 ? entry.cost : null;
            if (cost !== null) cache.set(id, cost);
            else cache.delete(id);
            settle(id, cost);
          }
        } catch (error) {
          state.lastError = `ERR ${error instanceof Error ? error.message : String(error)}`.slice(0, 40);
          for (const id of ids) settle(id, null);
        }
      }

      /** Highest turn number present in a cost table, or -1 when empty. */
      function maxTurnOf(table) {
        let max = -1;
        for (const key of Object.keys(table)) {
          const value = Number(key);
          if (Number.isFinite(value) && value > max) max = value;
        }
        return max;
      }

      function formatCost(cost) {
        if (!(cost > 0)) return null;
        if (cost < 0.0001) return '<0.0001';
        if (cost < 0.001) return cost.toFixed(4);
        if (cost < 0.01) return cost.toFixed(3);
        return cost.toFixed(2);
      }

      function TurnCostBadge(props) {
        const messageId = typeof props.messageId === 'string' ? props.messageId : undefined;
        const [cost, setCost] = react.useState(
          messageId !== undefined && cache.has(messageId) ? cache.get(messageId) : undefined,
        );

        react.useEffect(() => {
          if (messageId === undefined) return undefined;
          if (cache.has(messageId)) {
            setCost(cache.get(messageId));
            return undefined;
          }
          let disposed = false;
          let attempts = 0;
          let retry = null;
          const ask = () => {
            if (disposed) return;
            let set = waiters.get(messageId);
            if (set === undefined) {
              set = new Set();
              waiters.set(messageId, set);
            }
            set.add(setCost);
            queue.add(messageId);
            schedule();
            attempts += 1;
            if (attempts < 4) {
              retry = setTimeout(() => {
                if (!cache.has(messageId)) ask();
              }, 600 * attempts);
            }
          };
          ask();
          return () => {
            disposed = true;
            if (retry !== null) clearTimeout(retry);
            const current = waiters.get(messageId);
            if (current !== undefined) current.delete(setCost);
          };
        }, [messageId]);

        // Always render something: a live price when known, a faint placeholder
        // otherwise, so a loaded-but-dataless badge is distinguishable from a
        // plugin that never mounted at all.
        const text = formatCost(cost);
        const known = text !== null;
        const diag = known ? null : state.lastError;
        return jsx('span', {
          className: 'dsh-turn-cost',
          title: known ? `本轮约 ¥${cost.toFixed(4)}（人民币）` : `dsh-turn-cost 已挂载，费用未取到：${diag ?? '无数据'}`,
          style: {
            order: 99,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '1px',
            // Match the timestamp next to it exactly: same size token, same
            // line box, same tertiary label color. `font: inherit` would fall
            // back to the action row's default size and read as oversized.
            color: known ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-error, #c0392b)',
            fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
            lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
            fontWeight: 'normal',
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            opacity: known ? 1 : 0.5,
          },
          children: known ? `${text}🐟` : diag !== null ? `${diag} 🐟` : '··🐟',
        });
      }

      /* ------------------------------------------------------------------ *
       * Turn-tail badge.
       *
       * Old turns whose reply carries no closing node never render the action
       * row at all, so the assistant-actions badge above is invisible there and
       * no amount of hovering helps. The turn-tail slot is rendered for every
       * turn, so this second badge covers exactly those turns — it asks the DOM
       * whether an action row exists for its own turn and steps aside when one
       * does, keeping a single price per turn.
       * ------------------------------------------------------------------ */

      /** sessionId -> { status: 'loading' | 'ready' | 'error', turns, error } */
      const sessions = new Map();
      /** sessionId -> Set<listener> */
      const sessionListeners = new Map();
      /** "<sessionId>|<turn>" already reported as a lookup miss */
      const reportedMisses = new Set();

      function notifySession(sessionId) {
        const set = sessionListeners.get(sessionId);
        if (set === undefined) return;
        const entry = sessions.get(sessionId);
        for (const fn of set) fn(entry);
      }

      function requestSession(sessionId) {
        const current = sessions.get(sessionId);
        if (current !== undefined && (current.status === 'loading' || current.status === 'ready')) return;
        sessions.set(sessionId, { status: 'loading', turns: {} });
        state.requests += 1;
        fetch('/api/dsh-turn-cost', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId }),
        })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((json) => {
            const turns = json && json.turns && typeof json.turns === 'object' ? json.turns : {};
            sessions.set(sessionId, { status: 'ready', turns });
            notifySession(sessionId);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            sessions.set(sessionId, { status: 'error', turns: {}, error: message });
            state.lastError = message.slice(0, 40);
            notifySession(sessionId);
          });
      }

      const badgeStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '1px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
        fontWeight: 'normal',
        fontFamily: 'inherit',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      };

      function TurnCostTail(props) {
        // The slot hands over `node.location.turn`, which is the turn *record*,
        // not the turn number: chat.js reads `node.location.turn.turn` in three
        // other places. String(record) is "[object Object]", which is why the
        // table lookup scored zero hits until we unwrapped it.
        const turnRecord = props.turn;
        const turn = turnRecord !== null && typeof turnRecord === 'object' ? turnRecord.turn : turnRecord;
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
        const [snapshot, setSnapshot] = react.useState(undefined);

        react.useEffect(() => {
          if (sessionId === undefined) return undefined;
          const listener = (entry) => setSnapshot(entry);
          let set = sessionListeners.get(sessionId);
          if (set === undefined) {
            set = new Set();
            sessionListeners.set(sessionId, set);
          }
          set.add(listener);
          if (sessions.has(sessionId)) setSnapshot(sessions.get(sessionId));
          requestSession(sessionId);
          return () => {
            set.delete(listener);
          };
        }, [sessionId]);

        if (turn === undefined) return null;

        const table = snapshot !== undefined && snapshot.status === 'ready' ? snapshot.turns : undefined;
        const raw = table !== undefined && turn !== undefined ? table[String(turn)] : undefined;
        // The turn that is still streaming has no usage row yet. Stay quiet for
        // it instead of printing a placeholder under every unfinished turn; the
        // number appears as soon as the turn closes.
        if (typeof raw !== 'number' && table !== undefined && Number(turn) > maxTurnOf(table)) return null;
        if (typeof raw !== 'number' && table !== undefined) {
          // One report per (session, turn): a mismatch here means the turn key
          // the slot hands us is not the key the host table uses.
          const key = `${sessionId}|${String(turn)}`;
          if (!reportedMisses.has(key)) {
            reportedMisses.add(key);
            try {
              fetch('/api/dsh-turn-cost/report', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  kind: 'tail-miss',
                  sessionId,
                  turn: String(turn),
                  turnType: typeof turn,
                  keys: Object.keys(table).slice(0, 10),
                }),
              }).catch(() => {});
            } catch {}
          }
        }
        const text = typeof raw === 'number' ? formatCost(raw) : null;
        const known = text !== null;
        // Distinguish the three empty states in the glyph itself, because the
        // title tooltip is hover-only and the user is reading at a glance:
        //   …🐟  table still loading     ··🐟  table loaded, turn key missing
        //   !!🐟  request failed         ?🐟   no session id injected
        const pending = table === undefined;
        const failed = snapshot !== undefined && snapshot.status === 'error';
        const glyph = known
          ? `${text}🐟`
          : sessionId === undefined
            ? '?🐟'
            : failed
              ? '!!🐟'
              : pending
                ? '…🐟'
                : '··🐟';
        return jsx('div', {
          className: 'dsh-turn-cost-tail',
          style: { display: 'flex', justifyContent: 'flex-end', paddingRight: '10px' },
          children: jsx('span', {
            className: 'dsh-turn-cost',
            title: known
              ? `本轮约 ¥${raw.toFixed(4)}（人民币）`
              : `dsh-turn-cost 尾部徽章：${glyph}（turn=${String(turn)}, 表=${table === undefined ? '未就绪' : Object.keys(table).join(',')}）`,
            style: badgeStyle,
            children: glyph,
          }),
        });
      }

      exports.TurnCostTail = TurnCostTail;
      exports.TurnCostBadge = TurnCostBadge;
      badge = TurnCostBadge;
      tail = TurnCostTail;
    }

    function report() {
      try {
        fetch('/api/dsh-turn-cost/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status: state.status,
            error: state.error,
            requests: state.requests,
            href: typeof location !== 'undefined' ? String(location.href).slice(0, 120) : '',
          }),
        }).catch(() => {});
      } catch {}
    }

    function apply(ctx) {
      try {
        if (badge === null) {
          state.status = 'no-component';
          return;
        }
        if (!ctx || typeof ctx !== 'object' || ctx.slots === undefined) {
          state.status = 'no-slots';
          return;
        }
        // Only the turnTail entry is registered. The assistant-actions entry
        // sits inside `.actions`, and DSH hides that whole row with
        // `[data-actions-reveal=hover] .actions { opacity: 0 }`, so a badge
        // there is invisible until the pointer is over the message — which is
        // exactly what made finished sessions look like they had no price.
        if (tail !== null) {
          ctx.slots.inject('conversation.chat.turnTail', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'turn-cost-tail',
                order: 20,
                inject: (sessionId) => ({ sessionId }),
              },
              tail,
            ),
          );
          state.tailRegistered = true;
        }
        state.registered = true;
        state.status = 'ready';
      } catch (error) {
        state.status = 'apply-failed';
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        report();
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
