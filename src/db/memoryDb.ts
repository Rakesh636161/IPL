import crypto from 'node:crypto';
import * as schema from './schema.ts';

type AnyRecord = Record<string, any>;

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
const DRIZZLE_COLUMNS = Symbol.for('drizzle:Columns');

interface TableMeta {
  name: string;
  table: any;
  colsByProp: Map<string, any>;
  propByColName: Map<string, string>;
  uniqueKeys: string[][];
}

const TABLE_UNIQUE_KEYS: Record<string, string[][]> = {
  users: [['id'], ['uid']],
  user_profiles: [['id'], ['userId'], ['uniquePlayerId']],
  franchises: [['id']],
  friends: [['id'], ['requesterId', 'addresseeId']],
  leagues: [['id'], ['inviteCode']],
  league_settings: [['id'], ['leagueId']],
  league_members: [['id'], ['leagueId', 'userId']],
  league_invitations: [['id']],
  league_activity: [['id']],
  teams: [['id'], ['leagueId', 'ownerId']],
  players: [['id'], ['playerCode']],
  player_seasons: [['id']],
  auctions: [['id'], ['leagueId']],
  auction_lots: [['id'], ['auctionId', 'playerId']],
  auction_bids: [['id']],
  auction_events: [['id'], ['auctionId', 'idempotencyKey']],
  auction_results: [['id'], ['lotId'], ['leagueId', 'playerId']],
  team_players: [['id'], ['leagueId', 'playerId']],
  fixtures: [['id']],
  matches: [['id']],
  match_innings: [['id']],
  match_events: [['id']],
  standings: [['id'], ['leagueId', 'teamId']],
  notifications: [['id']],
  audit_logs: [['id']],
  distributed_locks: [['lockKey']],
  realtime_cache: [['cacheKey']],
};

const CASCADE_RULES: Array<{ parentTable: string; childTable: string; fkProp: string; parentProp: string }> = [
  { parentTable: 'users', childTable: 'user_profiles', fkProp: 'userId', parentProp: 'id' },
  { parentTable: 'users', childTable: 'franchises', fkProp: 'ownerId', parentProp: 'id' },
  { parentTable: 'users', childTable: 'friends', fkProp: 'requesterId', parentProp: 'id' },
  { parentTable: 'users', childTable: 'friends', fkProp: 'addresseeId', parentProp: 'id' },
  { parentTable: 'users', childTable: 'league_members', fkProp: 'userId', parentProp: 'id' },
  { parentTable: 'users', childTable: 'notifications', fkProp: 'userId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'league_settings', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'league_members', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'league_invitations', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'league_activity', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'teams', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'auctions', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'auction_bids', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'auction_results', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'team_players', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'fixtures', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'matches', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'leagues', childTable: 'standings', fkProp: 'leagueId', parentProp: 'id' },
  { parentTable: 'auctions', childTable: 'auction_lots', fkProp: 'auctionId', parentProp: 'id' },
  { parentTable: 'auctions', childTable: 'auction_bids', fkProp: 'auctionId', parentProp: 'id' },
  { parentTable: 'auctions', childTable: 'auction_events', fkProp: 'auctionId', parentProp: 'id' },
  { parentTable: 'auctions', childTable: 'auction_results', fkProp: 'auctionId', parentProp: 'id' },
  { parentTable: 'teams', childTable: 'team_players', fkProp: 'teamId', parentProp: 'id' },
  { parentTable: 'teams', childTable: 'standings', fkProp: 'teamId', parentProp: 'id' },
  { parentTable: 'matches', childTable: 'match_innings', fkProp: 'matchId', parentProp: 'id' },
  { parentTable: 'matches', childTable: 'match_events', fkProp: 'matchId', parentProp: 'id' },
];

function getTableName(table: any): string {
  return table?.[DRIZZLE_NAME] ?? table?._?.name ?? 'unknown';
}

function isColumn(obj: any): boolean {
  return Boolean(obj && typeof obj === 'object' && typeof obj.name === 'string' && 'table' in obj && 'dataType' in obj);
}

function isSqlNode(obj: any): boolean {
  return Boolean(obj && typeof obj === 'object' && Array.isArray(obj.queryChunks));
}

function isStringChunk(obj: any): boolean {
  return Boolean(obj && typeof obj === 'object' && Array.isArray(obj.value) && !('queryChunks' in obj) && !('encoder' in obj));
}

function isParam(obj: any): boolean {
  return Boolean(obj && typeof obj === 'object' && 'value' in obj && 'encoder' in obj);
}

function extractSqlText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (isStringChunk(node)) return node.value.join('');
  if (isColumn(node)) return node.name;
  if (isParam(node)) return String(node.value);
  if (isSqlNode(node)) return node.queryChunks.map(extractSqlText).join('');
  return '';
}

function cloneValue(val: any): any {
  if (val instanceof Date) return new Date(val.getTime());
  if (Array.isArray(val)) return val.map(cloneValue);
  if (val && typeof val === 'object') {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = cloneValue(v);
    }
    return out;
  }
  return val;
}

function toComparable(val: any): any {
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
    const ms = Date.parse(val);
    if (!Number.isNaN(ms)) return ms;
  }
  return val;
}

function buildTableRegistry(): Map<string, TableMeta> {
  const registry = new Map<string, TableMeta>();
  for (const val of Object.values(schema)) {
    if (!val || typeof val !== 'object') continue;
    const name = (val as any)[DRIZZLE_NAME];
    if (typeof name !== 'string') continue;

    const colsObj = (val as any)[DRIZZLE_COLUMNS] ?? val;
    const colsByProp = new Map<string, any>();
    const propByColName = new Map<string, string>();
    for (const [prop, rawCol] of Object.entries(colsObj)) {
      const col = rawCol as any;
      if (isColumn(col)) {
        colsByProp.set(prop, col);
        propByColName.set(col.name, prop);
      }
    }
    registry.set(name, {
      name,
      table: val,
      colsByProp,
      propByColName,
      uniqueKeys: TABLE_UNIQUE_KEYS[name] ?? [['id']],
    });
  }
  return registry;
}

export function createMemoryDb() {
  const registry = buildTableRegistry();
  let store = new Map<string, AnyRecord[]>();
  for (const name of registry.keys()) {
    store.set(name, []);
  }

  let txQueue: Promise<any> = Promise.resolve();

  function getRows(tableName: string): AnyRecord[] {
    let rows = store.get(tableName);
    if (!rows) {
      rows = [];
      store.set(tableName, rows);
    }
    return rows;
  }

  function resolveColumnValue(col: any, ctx: Map<string, AnyRecord | null>): any {
    const tName = getTableName(col.table);
    const meta = registry.get(tName);
    const row = ctx.get(tName);
    if (!row || !meta) return undefined;
    const prop = meta.propByColName.get(col.name) ?? col.name;
    return row[prop];
  }

  function resolveOperand(op: any, ctx: Map<string, AnyRecord | null>): any {
    if (isColumn(op)) return resolveColumnValue(op, ctx);
    if (isParam(op)) return op.value;
    return op;
  }

  function evalCondition(cond: any, ctx: Map<string, AnyRecord | null>): boolean {
    if (!cond) return true;
    if (!isSqlNode(cond)) return Boolean(cond);

    const chunks = cond.queryChunks as any[];
    if (chunks.length === 0) return true;

    // Parenthesized group: ["(", inner, ")"]
    if (
      chunks.length === 3 &&
      isStringChunk(chunks[0]) &&
      chunks[0].value.join('') === '(' &&
      isStringChunk(chunks[2]) &&
      chunks[2].value.join('') === ')'
    ) {
      return evalCondition(chunks[1], ctx);
    }

    // Check for logical combinator (" and " / " or ") at top level of chunks
    const hasAnd = chunks.some((c) => isStringChunk(c) && c.value.join('').trim().toLowerCase() === 'and');
    const hasOr = chunks.some((c) => isStringChunk(c) && c.value.join('').trim().toLowerCase() === 'or');

    if (hasAnd || hasOr) {
      // Split by operators
      const parts: any[] = [];
      const ops: string[] = [];
      for (const chunk of chunks) {
        if (isStringChunk(chunk)) {
          const txt = chunk.value.join('').trim().toLowerCase();
          if (txt === 'and' || txt === 'or') {
            ops.push(txt);
          } else if (txt === '(' || txt === ')' || txt === '') {
            continue;
          }
        } else {
          parts.push(chunk);
        }
      }
      if (parts.length > 0) {
        let acc = evalCondition(parts[0], ctx);
        for (let i = 0; i < ops.length && i + 1 < parts.length; i++) {
          const rhs = evalCondition(parts[i + 1], ctx);
          acc = ops[i] === 'and' ? acc && rhs : acc || rhs;
        }
        return acc;
      }
    }

    // Binary comparison: [emptyStr, lhs, opChunk, rhs, emptyStr]
    const meaningful = chunks.filter((c) => !(isStringChunk(c) && c.value.join('') === ''));
    if (meaningful.length >= 3 && isStringChunk(meaningful[1])) {
      const op = meaningful[1].value.join('').trim().toLowerCase();
      const lhs = resolveOperand(meaningful[0], ctx);
      const rhsRaw = meaningful[2];

      if (op === 'in' && Array.isArray(rhsRaw)) {
        const vals = rhsRaw.map((item) => resolveOperand(item, ctx));
        return vals.includes(lhs);
      }

      const rhs = resolveOperand(rhsRaw, ctx);
      if (op === '=') return lhs === rhs;
      if (op === '<>' || op === '!=') return lhs !== rhs;
      if (op === '>') return toComparable(lhs) > toComparable(rhs);
      if (op === '<') return toComparable(lhs) < toComparable(rhs);
      if (op === '>=') return toComparable(lhs) >= toComparable(rhs);
      if (op === '<=') return toComparable(lhs) <= toComparable(rhs);
      if (op === 'ilike' || op === 'like') {
        const pattern = String(rhs)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/%/g, '.*')
          .replace(/_/g, '.');
        return new RegExp(`^${pattern}$`, op === 'ilike' ? 'i' : '').test(String(lhs ?? ''));
      }
    }

    // Unary IS NULL / IS NOT NULL
    if (meaningful.length === 2 && isStringChunk(meaningful[1])) {
      const op = meaningful[1].value.join('').trim().toLowerCase();
      const lhs = resolveOperand(meaningful[0], ctx);
      if (op === 'is null') return lhs === null || lhs === undefined;
      if (op === 'is not null') return lhs !== null && lhs !== undefined;
    }

    return true;
  }

  function applyDefaults(meta: TableMeta, input: AnyRecord): AnyRecord {
    const row: AnyRecord = {};
    for (const [prop, col] of meta.colsByProp.entries()) {
      if (input[prop] !== undefined) {
        row[prop] = cloneValue(input[prop]);
      } else if (col.columnType === 'PgUUID' && col.primary && col.hasDefault) {
        row[prop] = crypto.randomUUID();
      } else if (col.columnType === 'PgTimestamp' && col.hasDefault) {
        row[prop] = new Date();
      } else if (col.default !== undefined && typeof col.default !== 'object') {
        row[prop] = col.default;
      } else {
        row[prop] = null;
      }
    }
    return row;
  }

  function projectSelection(selection: AnyRecord | undefined, ctx: Map<string, AnyRecord | null>, baseTableName: string, groupCount?: number): AnyRecord {
    if (!selection) {
      return cloneValue(ctx.get(baseTableName) ?? {});
    }
    const out: AnyRecord = {};
    for (const [key, val] of Object.entries(selection)) {
      if (isColumn(val)) {
        out[key] = cloneValue(resolveColumnValue(val, ctx));
      } else if (isSqlNode(val)) {
        const txt = extractSqlText(val).toLowerCase();
        if (txt.includes('count(')) {
          out[key] = groupCount ?? 0;
        } else {
          out[key] = null;
        }
      } else if (val && typeof val === 'object' && (val as any)[DRIZZLE_NAME]) {
        const tName = getTableName(val);
        const target = ctx.get(tName);
        out[key] = target ? cloneValue(target) : null;
      } else {
        out[key] = cloneValue(val);
      }
    }
    return out;
  }

  function findConflictIndex(meta: TableMeta, rows: AnyRecord[], candidate: AnyRecord, targetCols?: any): number {
    const targetProps: string[] | null = targetCols
      ? (Array.isArray(targetCols) ? targetCols : [targetCols]).map((c) => meta.propByColName.get(c.name) ?? c.name)
      : null;

    const keyGroups = targetProps ? [targetProps] : meta.uniqueKeys;
    for (const keyCols of keyGroups) {
      const idx = rows.findIndex((existing) =>
        keyCols.every((prop) => {
          const a = existing[prop];
          const b = candidate[prop];
          return a !== null && a !== undefined && b !== null && b !== undefined && a === b;
        })
      );
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function cascadeDelete(tableName: string, deletedRows: AnyRecord[]) {
    if (deletedRows.length === 0) return;
    for (const rule of CASCADE_RULES) {
      if (rule.parentTable !== tableName) continue;
      const parentVals = new Set(deletedRows.map((r) => r[rule.parentProp]).filter((v) => v !== null && v !== undefined));
      if (parentVals.size === 0) continue;
      const childRows = getRows(rule.childTable);
      const removedChildren: AnyRecord[] = [];
      const kept: AnyRecord[] = [];
      for (const cr of childRows) {
        if (parentVals.has(cr[rule.fkProp])) {
          removedChildren.push(cr);
        } else {
          kept.push(cr);
        }
      }
      if (removedChildren.length > 0) {
        store.set(rule.childTable, kept);
        cascadeDelete(rule.childTable, removedChildren);
      }
    }
  }

  function makeExecutor() {
    const executor: AnyRecord = {
      select(selection?: AnyRecord) {
        const state: {
          fromTable?: any;
          joins: Array<{ type: 'inner' | 'left'; table: any; on: any }>;
          whereCond?: any;
          orderCols: any[];
          groupCols: any[];
          limitNum?: number;
        } = {
          joins: [],
          orderCols: [],
          groupCols: [],
        };

        const runSelect = (): AnyRecord[] => {
          if (!state.fromTable) return [];
          const baseName = getTableName(state.fromTable);
          const baseRows = getRows(baseName);

          let contexts: Map<string, AnyRecord | null>[] = baseRows.map((r) => {
            const m = new Map<string, AnyRecord | null>();
            m.set(baseName, r);
            return m;
          });

          for (const j of state.joins) {
            const jName = getTableName(j.table);
            const jRows = getRows(jName);
            const nextContexts: Map<string, AnyRecord | null>[] = [];

            for (const ctx of contexts) {
              let matched = false;
              for (const jr of jRows) {
                const candidate = new Map(ctx);
                candidate.set(jName, jr);
                if (evalCondition(j.on, candidate)) {
                  nextContexts.push(candidate);
                  matched = true;
                }
              }
              if (!matched && j.type === 'left') {
                const candidate = new Map(ctx);
                candidate.set(jName, null);
                nextContexts.push(candidate);
              }
            }
            contexts = nextContexts;
          }

          if (state.whereCond) {
            contexts = contexts.filter((ctx) => evalCondition(state.whereCond, ctx));
          }

          // Handle aggregate / groupBy
          const hasCountSelection =
            selection &&
            Object.values(selection).some((v) => isSqlNode(v) && extractSqlText(v).toLowerCase().includes('count('));

          if (state.groupCols.length > 0) {
            const groups = new Map<string, { ctx: Map<string, AnyRecord | null>; count: number }>();
            for (const ctx of contexts) {
              const gKey = state.groupCols.map((c) => String(resolveOperand(c, ctx))).join('::');
              const existing = groups.get(gKey);
              if (existing) {
                existing.count += 1;
              } else {
                groups.set(gKey, { ctx, count: 1 });
              }
            }
            let out = Array.from(groups.values()).map((g) =>
              projectSelection(selection, g.ctx, baseName, g.count)
            );
            if (state.limitNum !== undefined) out = out.slice(0, state.limitNum);
            return out;
          }

          if (hasCountSelection) {
            return [projectSelection(selection, contexts[0] ?? new Map(), baseName, contexts.length)];
          }

          if (state.orderCols.length > 0) {
            contexts.sort((ctxA, ctxB) => {
              for (const ord of state.orderCols) {
                let col = ord;
                let dir: 'asc' | 'desc' = 'asc';
                if (isSqlNode(ord)) {
                  const chunks = ord.queryChunks as any[];
                  const colChunk = chunks.find((c) => isColumn(c));
                  const dirChunk = chunks.find((c) => isStringChunk(c) && /asc|desc/i.test(c.value.join('')));
                  if (colChunk) col = colChunk;
                  if (dirChunk && /desc/i.test(dirChunk.value.join(''))) dir = 'desc';
                }
                const a = toComparable(resolveOperand(col, ctxA));
                const b = toComparable(resolveOperand(col, ctxB));
                if (a === b) continue;
                if (a === null || a === undefined) return 1;
                if (b === null || b === undefined) return -1;
                const cmp = a < b ? -1 : 1;
                return dir === 'desc' ? -cmp : cmp;
              }
              return 0;
            });
          }

          if (state.limitNum !== undefined) {
            contexts = contexts.slice(0, state.limitNum);
          }

          return contexts.map((ctx) => projectSelection(selection, ctx, baseName));
        };

        const builder: any = {
          from(table: any) {
            state.fromTable = table;
            return builder;
          },
          innerJoin(table: any, on: any) {
            state.joins.push({ type: 'inner', table, on });
            return builder;
          },
          leftJoin(table: any, on: any) {
            state.joins.push({ type: 'left', table, on });
            return builder;
          },
          where(cond: any) {
            state.whereCond = cond;
            return builder;
          },
          orderBy(...cols: any[]) {
            state.orderCols.push(...cols);
            return builder;
          },
          groupBy(...cols: any[]) {
            state.groupCols.push(...cols);
            return builder;
          },
          limit(n: number) {
            state.limitNum = n;
            return builder;
          },
          for(_mode: string) {
            return builder;
          },
          then(resolve: (v: any) => any, reject?: (e: any) => any) {
            return Promise.resolve().then(runSelect).then(resolve, reject);
          },
        };
        return builder;
      },

      insert(table: any) {
        const tName = getTableName(table);
        const meta = registry.get(tName)!;
        let payloadRows: AnyRecord[] = [];
        let conflictMode: 'none' | 'nothing' | 'update' = 'none';
        let conflictTarget: any;
        let conflictSet: AnyRecord | undefined;
        let conflictWhere: any;
        let returningSel: AnyRecord | undefined;
        let hasReturning = false;

        const runInsert = () => {
          const rows = getRows(tName);
          const resultRows: AnyRecord[] = [];

          for (const input of payloadRows) {
            const candidate = applyDefaults(meta, input);
            const conflictIdx = findConflictIndex(meta, rows, candidate, conflictTarget);

            if (conflictIdx >= 0) {
              if (conflictMode === 'nothing') {
                continue;
              }
              if (conflictMode === 'update') {
                const existing = rows[conflictIdx];
                if (conflictWhere) {
                  const ctx = new Map<string, AnyRecord | null>([[tName, existing]]);
                  if (!evalCondition(conflictWhere, ctx)) {
                    continue;
                  }
                }
                const updated = { ...existing };
                for (const [k, v] of Object.entries(conflictSet || {})) {
                  if (v !== undefined) updated[k] = cloneValue(v);
                }
                rows[conflictIdx] = updated;
                resultRows.push(cloneValue(updated));
                continue;
              }
              throw new Error(`Duplicate unique key violation in ${tName}`);
            }

            rows.push(candidate);
            resultRows.push(cloneValue(candidate));
          }

          if (!hasReturning) return resultRows;
          if (!returningSel) return resultRows;
          return resultRows.map((r) =>
            projectSelection(returningSel, new Map([[tName, r]]), tName)
          );
        };

        const builder: any = {
          values(vals: AnyRecord | AnyRecord[]) {
            payloadRows = Array.isArray(vals) ? vals : [vals];
            return builder;
          },
          onConflictDoNothing(opts?: { target?: any }) {
            conflictMode = 'nothing';
            conflictTarget = opts?.target;
            return builder;
          },
          onConflictDoUpdate(opts: { target: any; set: AnyRecord; setWhere?: any }) {
            conflictMode = 'update';
            conflictTarget = opts.target;
            conflictSet = opts.set;
            conflictWhere = opts.setWhere;
            return builder;
          },
          returning(sel?: AnyRecord) {
            hasReturning = true;
            returningSel = sel;
            return builder;
          },
          then(resolve: (v: any) => any, reject?: (e: any) => any) {
            return Promise.resolve().then(runInsert).then(resolve, reject);
          },
        };
        return builder;
      },

      update(table: any) {
        const tName = getTableName(table);
        let setVals: AnyRecord = {};
        let whereCond: any;
        let returningSel: AnyRecord | undefined;
        let hasReturning = false;

        const runUpdate = () => {
          const rows = getRows(tName);
          const updatedRows: AnyRecord[] = [];
          for (let i = 0; i < rows.length; i++) {
            const ctx = new Map<string, AnyRecord | null>([[tName, rows[i]]]);
            if (!whereCond || evalCondition(whereCond, ctx)) {
              const next = { ...rows[i] };
              for (const [k, v] of Object.entries(setVals)) {
                if (v !== undefined) next[k] = cloneValue(v);
              }
              rows[i] = next;
              updatedRows.push(cloneValue(next));
            }
          }
          if (!hasReturning || !returningSel) return updatedRows;
          return updatedRows.map((r) =>
            projectSelection(returningSel, new Map([[tName, r]]), tName)
          );
        };

        const builder: any = {
          set(vals: AnyRecord) {
            setVals = vals;
            return builder;
          },
          where(cond: any) {
            whereCond = cond;
            return builder;
          },
          returning(sel?: AnyRecord) {
            hasReturning = true;
            returningSel = sel;
            return builder;
          },
          then(resolve: (v: any) => any, reject?: (e: any) => any) {
            return Promise.resolve().then(runUpdate).then(resolve, reject);
          },
        };
        return builder;
      },

      delete(table: any) {
        const tName = getTableName(table);
        let whereCond: any;
        let returningSel: AnyRecord | undefined;
        let hasReturning = false;

        const runDelete = () => {
          const rows = getRows(tName);
          const deleted: AnyRecord[] = [];
          const kept: AnyRecord[] = [];
          for (const r of rows) {
            const ctx = new Map<string, AnyRecord | null>([[tName, r]]);
            if (!whereCond || evalCondition(whereCond, ctx)) {
              deleted.push(cloneValue(r));
            } else {
              kept.push(r);
            }
          }
          store.set(tName, kept);
          cascadeDelete(tName, deleted);
          if (!hasReturning || !returningSel) return deleted;
          return deleted.map((r) =>
            projectSelection(returningSel, new Map([[tName, r]]), tName)
          );
        };

        const builder: any = {
          where(cond: any) {
            whereCond = cond;
            return builder;
          },
          returning(sel?: AnyRecord) {
            hasReturning = true;
            returningSel = sel;
            return builder;
          },
          then(resolve: (v: any) => any, reject?: (e: any) => any) {
            return Promise.resolve().then(runDelete).then(resolve, reject);
          },
        };
        return builder;
      },

      async execute(querySql: any) {
        const text = extractSqlText(querySql);
        if (text.includes('pg_advisory_xact_lock')) {
          return { rows: [] };
        }
        if (text.includes('unique_player_id')) {
          const profiles = getRows('user_profiles');
          let maxNum = 100000;
          for (const p of profiles) {
            if (typeof p.uniquePlayerId === 'string' && /^CV[0-9]{6,}$/.test(p.uniquePlayerId)) {
              const n = Number(p.uniquePlayerId.slice(2));
              if (n > maxNum) maxNum = n;
            }
          }
          return { rows: [{ max_num: maxNum }] };
        }
        return { rows: [] };
      },

      async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
        const run = async () => {
          const snapshot = new Map<string, AnyRecord[]>();
          for (const [k, v] of store.entries()) {
            snapshot.set(k, v.map((r) => cloneValue(r)));
          }
          try {
            return await fn(executor);
          } catch (err) {
            store = snapshot;
            throw err;
          }
        };
        const p = txQueue.then(run, run);
        txQueue = p.catch(() => {});
        return p;
      },
    };

    return executor;
  }

  return makeExecutor();
}
