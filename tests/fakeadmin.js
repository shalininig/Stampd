// Minimal in-memory stand-in for firebase-admin's Firestore, enough for
// Stampd/functions/index.js. Not a general implementation.
"use strict";

let NOW = Date.now();
const clock = { now: () => NOW, set: (ms) => { NOW = ms; }, advanceDays: (d) => { NOW += d * 86400000; } };

class Timestamp {
  constructor(ms) { this._ms = ms; this.seconds = Math.floor(ms / 1000); }
  toDate() { return new Date(this._ms); }
  toMillis() { return this._ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
}

const OP = (op, args) => ({ __op: op, args });
const FieldValue = {
  serverTimestamp: () => OP("ts"),
  increment: (n) => OP("inc", n),
  delete: () => OP("del"),
  arrayUnion: (...a) => OP("union", a),
  arrayRemove: (...a) => OP("remove", a),
};

const store = new Map(); // path -> data
let autoId = 0;

function applyWrite(path, data, merge) {
  const prev = merge ? { ...(store.get(path) || {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && v.__op) {
      if (v.__op === "ts") prev[k] = new Timestamp(NOW);
      else if (v.__op === "inc") prev[k] = (prev[k] || 0) + v.args;
      else if (v.__op === "del") delete prev[k];
      else if (v.__op === "union") prev[k] = [...new Set([...(prev[k] || []), ...v.args])];
      else if (v.__op === "remove") prev[k] = (prev[k] || []).filter((x) => !v.args.includes(x));
    } else prev[k] = v;
  }
  store.set(path, prev);
}

function snapOf(path, id) {
  const d = store.get(path);
  return {
    id, exists: d !== undefined, ref: docRef(path),
    data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d), revive)),
  };
}
// keep Timestamps alive through the defensive copy
function revive(k, v) { return v && typeof v === "object" && "_ms" in v ? new Timestamp(v._ms) : v; }

function docRef(path) {
  const id = path.split("/").pop();
  return {
    id, path,
    get: async () => snapOf(path, id),
    set: async (data, opts) => applyWrite(path, data, !!(opts && opts.merge)),
    update: async (data) => applyWrite(path, data, true),
  };
}

function cmp(a, op, b) {
  const val = (x) => (x && x.toMillis ? x.toMillis() : x);
  a = val(a); b = val(b);
  if (op === "==") return a === b;
  if (op === ">") return a > b;
  if (op === ">=") return a >= b;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  throw new Error("op " + op);
}

function queryRef(coll, filters = []) {
  return {
    where: (f, op, v) => queryRef(coll, [...filters, [f, op, v]]),
    get: async () => {
      const docs = [];
      for (const [p] of store) {
        const parts = p.split("/");
        if (parts.length !== 2 || parts[0] !== coll) continue;
        const s = snapOf(p, parts[1]);
        const d = s.data();
        if (filters.every(([f, op, v]) => d[f] !== undefined && cmp(d[f], op, v))) docs.push(s);
      }
      return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
    },
  };
}

const db = {
  collection: (name) => ({
    ...queryRef(name),
    doc: (id) => docRef(`${name}/${id || "auto" + ++autoId}`),
  }),
  runTransaction: async (fn) => {
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, data, opts) => applyWrite(ref.path, data, !!(opts && opts.merge)),
      update: (ref, data) => applyWrite(ref.path, data, true),
    };
    return fn(tx);
  },
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const f of ops) await f(); } }; },
};

function firestore() { return db; }
firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;

module.exports = { initializeApp: () => ({}), firestore, _store: store, _clock: clock, _Timestamp: Timestamp };
