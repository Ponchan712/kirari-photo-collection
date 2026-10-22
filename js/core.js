// きらりんフォトコレクション（Web版）— データ・集計・保存・バックアップ
// 画面（app.js）から切り離し、ブラウザでテストできるようにしている。

export const APP_ID = 'kirari-photo-collection-web';
export const FORMAT_VERSION = 2;

/** 全シリーズ共通の4カット（この順番で固定） */
export const CUTS = [
  { key: 'yori', label: 'ヨリ' },
  { key: 'chu', label: 'チュウ' },
  { key: 'hiki', label: 'ヒキ' },
  { key: 'suwari', label: '座り' },
];
export const CUT_COUNT = CUTS.length;
const CUT_KEYS = new Set(CUTS.map((c) => c.key));

/**
 * 保存データ（形式2）
 * owned[シリーズID][カットのkey] = true/false（記録がなければ未所持）
 * legacy[シリーズID] = [{label, owned}] … 形式1から移行できなかった4カット以外のカット（集計対象外・保管のみ）
 * migration = {from, at, legacyCount} … 形式1から移行した記録
 */
export function emptyState() {
  return { app: APP_ID, version: FORMAT_VERSION, updatedAt: null, owned: {}, legacy: {}, migration: null };
}

// ---------- 集計 ----------

export const isOwned = (state, sid, key) => state.owned[sid]?.[key] === true;

export function seriesStats(state, sid) {
  const owned = CUTS.filter((c) => isOwned(state, sid, c.key)).length;
  return {
    owned,
    total: CUT_COUNT,
    missing: CUT_COUNT - owned,
    rate: Math.floor((owned / CUT_COUNT) * 100), // 0・25・50・75・100
    complete: owned === CUT_COUNT,
  };
}

/** 全体の集計。分母はシリーズ数×4（137シリーズなら548） */
export function totals(seriesList, state) {
  let owned = 0, complete = 0;
  for (const s of seriesList) {
    const st = seriesStats(state, s.id);
    owned += st.owned;
    if (st.complete) complete++;
  }
  const total = seriesList.length * CUT_COUNT;
  return {
    seriesCount: seriesList.length,
    total,
    owned,
    missing: total - owned,
    complete,
    rate: total ? Math.floor((owned / total) * 1000) / 10 : 0, // 小数点1桁（切り捨て）
  };
}

/** 未所持のカット一覧（4種類を基準） */
export function missingList(seriesList, state) {
  const out = [];
  for (const s of seriesList) {
    const cuts = CUTS.filter((c) => !isOwned(state, s.id, c.key));
    if (cuts.length) out.push({ series: s, cuts });
  }
  return out;
}

/** 検索用：全角/半角・大文字/小文字・空白の違いを無視 */
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// ---------- 編集 ----------

export function toggleOwned(state, sid, key) {
  if (!CUT_KEYS.has(key)) return state;
  const cur = { ...(state.owned[sid] ?? {}) };
  cur[key] = !(cur[key] === true);
  return { ...state, owned: { ...state.owned, [sid]: cur } };
}

// ---------- 形式1（カット自由設定）からの移行 ----------

/** カット名が4カットのどれかなら、そのkeyを返す（表記の全角/半角・前後の空白は同一視） */
export function cutKeyOf(label) {
  const n = String(label ?? '').normalize('NFKC').trim();
  return CUTS.find((c) => c.label === n)?.key ?? null;
}

/**
 * 形式1の records（{シリーズID: {cuts:[{label, owned}]}}）を形式2へ移す。
 * 4カットと同じ名前の所持チェックはそのまま引き継ぎ、それ以外のカットは削除・付け替えせず legacy に保管する。
 */
export function migrateRecords(records) {
  const st = emptyState();
  const report = { series: 0, carried: 0, legacy: [] };
  for (const [sid, rec] of Object.entries(records ?? {})) {
    const cuts = Array.isArray(rec?.cuts) ? rec.cuts : [];
    if (!cuts.length) continue;
    report.series++;
    for (const c of cuts) {
      const label = String(c?.label ?? '').trim();
      const owned = c?.owned === true;
      const key = cutKeyOf(label);
      if (key) {
        // 同じカットが重複していた場合は「所持」を優先（チェックを失わない）
        (st.owned[sid] ??= {})[key] = (st.owned[sid][key] === true) || owned;
        report.carried++;
      } else if (label) {
        (st.legacy[sid] ??= []).push({ label, owned });
        report.legacy.push({ seriesId: sid, label, owned });
      }
    }
  }
  st.migration = { from: 1, at: new Date().toISOString(), legacyCount: report.legacy.length };
  return { state: st, report };
}

/**
 * 保存データを最新形式にそろえる。
 * 形式1なら移行し、report（移行内容）を返す。最新形式ならそのまま（reportはnull）。
 */
export function upgradeState(raw) {
  if (!raw || raw.app !== APP_ID) return { state: emptyState(), report: null };
  if (raw.version === FORMAT_VERSION && raw.owned && typeof raw.owned === 'object') {
    return { state: { ...emptyState(), ...raw, legacy: raw.legacy ?? {} }, report: null };
  }
  if (raw.records && typeof raw.records === 'object') {
    const r = migrateRecords(raw.records);
    r.state.updatedAt = raw.updatedAt ?? null;
    return r;
  }
  return { state: emptyState(), report: null };
}

// ---------- バックアップ ----------

export function exportBackup(state, seed) {
  return JSON.stringify(
    {
      app: APP_ID,
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      member: seed?.member ?? null,
      seriesCount: seed?.series?.length ?? null,
      cuts: CUTS.map((c) => c.label),
      owned: state.owned,
      legacy: state.legacy,
      migration: state.migration,
    },
    null,
    1,
  );
}

/**
 * バックアップファイルを読み込み、検証する（この時点では保存データを変更しない）。
 * 対応形式：このWeb版（形式2・形式1）／HTML試作版／Androidアプリ版
 * 失敗時は Error（日本語メッセージ）を投げる。
 */
export function parseBackup(text, knownIds) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSONファイルとして読み込めませんでした。');
  }
  if (!raw || typeof raw !== 'object') throw new Error('対応していないファイルです。');
  const known = new Set(knownIds);
  let state, kind;

  if (raw.app === APP_ID && raw.version === FORMAT_VERSION) {
    kind = 'このWeb版のバックアップ';
    state = validateV2(raw);
  } else if (raw.app === APP_ID) {
    kind = 'このWeb版の旧形式バックアップ（4カット方式へ移行）';
    state = migrateRecords(validateV1(raw.records)).state;
  } else if (raw.app === 'kirari-photocollection' || (raw.version === 1 && raw.collection)) {
    kind = 'HTML試作版のバックアップ（4カット方式へ移行）';
    state = migrateRecords(validateV1(fromHtmlPrototype(raw.app ? raw.data : raw))).state;
  } else if (raw.app === 'kirari-photo-collection' && raw.tables) {
    kind = 'Androidアプリ版のバックアップ（4カット方式へ移行）';
    state = migrateRecords(validateV1(fromFlutterApp(raw.tables))).state;
  } else {
    throw new Error('きらりんフォトコレクションのバックアップではありません。');
  }

  // 137シリーズ以外（自分で追加したシリーズ等）は取り込まない
  let skipped = 0;
  for (const part of ['owned', 'legacy']) {
    for (const sid of Object.keys(state[part])) {
      if (!known.has(sid)) {
        delete state[part][sid];
        if (part === 'owned') skipped++;
      }
    }
  }
  const ownedCount = Object.values(state.owned).reduce((n, o) => n + CUTS.filter((c) => o[c.key] === true).length, 0);
  const legacyCount = Object.values(state.legacy).reduce((n, l) => n + l.length, 0);
  return {
    kind,
    state,
    seriesCount: Object.keys(state.owned).length,
    ownedCount,
    legacyCount,
    skipped,
    exportedAt: raw.exportedAt ?? raw.exported_at ?? null,
  };
}

function validateV2(raw) {
  const bad = () => { throw new Error('バックアップの中身が壊れています。'); };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(raw.owned)) bad();
  const st = emptyState();
  for (const [sid, o] of Object.entries(raw.owned)) {
    if (!isObj(o)) bad();
    const clean = {};
    for (const [k, v] of Object.entries(o)) {
      if (!CUT_KEYS.has(k) || typeof v !== 'boolean') bad();
      clean[k] = v;
    }
    st.owned[sid] = clean;
  }
  if (raw.legacy !== undefined && raw.legacy !== null) {
    if (!isObj(raw.legacy)) bad();
    for (const [sid, list] of Object.entries(raw.legacy)) {
      if (!Array.isArray(list) || list.some((c) => !c || typeof c.label !== 'string' || typeof c.owned !== 'boolean')) bad();
      st.legacy[sid] = list.map((c) => ({ label: c.label, owned: c.owned }));
    }
  }
  st.migration = isObj(raw.migration) ? raw.migration : null;
  return st;
}

function validateV1(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('バックアップの中身が壊れています。');
  for (const [id, rec] of Object.entries(records)) {
    if (!rec || !Array.isArray(rec.cuts) || rec.cuts.length > 300) throw new Error(`「${id}」のデータが壊れています。`);
    for (const c of rec.cuts) {
      if (!c || typeof c.label !== 'string' || typeof c.owned !== 'boolean') throw new Error(`「${id}」のカットのデータが壊れています。`);
    }
  }
  return records;
}

// HTML試作版：所持枚数（qty）1枚以上 → 所持
function fromHtmlPrototype(d) {
  if (!d || d.version !== 1 || typeof d.collection !== 'object') throw new Error('HTML試作版のバックアップが壊れています。');
  const out = {};
  for (const [id, r] of Object.entries(d.collection)) {
    if (!r || !Array.isArray(r.cuts)) continue;
    out[id] = { cuts: r.cuts.filter((c) => c && typeof c.label === 'string').map((c) => ({ label: c.label, owned: Number.isInteger(c.qty) && c.qty > 0 })) };
  }
  return out;
}

// Androidアプリ版：cuts テーブルの qty 1以上 → 所持
function fromFlutterApp(tables) {
  if (!Array.isArray(tables.series) || !Array.isArray(tables.cuts)) throw new Error('Androidアプリ版のバックアップが壊れています。');
  const out = {};
  const cuts = [...tables.cuts].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  for (const c of cuts) {
    if (!c || typeof c.series_id !== 'string' || typeof c.label !== 'string') continue;
    (out[c.series_id] ??= { cuts: [] }).cuts.push({ label: c.label, owned: Number.isInteger(c.qty) && c.qty > 0 });
  }
  return out;
}

// ---------- 端末への保存（IndexedDB ＋ localStorage の二重保存） ----------

export class Store {
  constructor(name = 'kirari_photo_collection') {
    this.name = name;
    this.lsKey = name + '__state';
    this.lsPreV2 = name + '__pre_v2_backup';
    this._db = null;
  }

  async _open() {
    if (this._db) return this._db;
    if (!('indexedDB' in globalThis)) return null;
    this._db = await new Promise((resolve) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // プライベートブラウズ等で使えない場合は localStorage のみ
      req.onblocked = () => resolve(null);
    });
    return this._db;
  }

  async _get(key) {
    const db = await this._open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
  }

  async _put(key, value) {
    const db = await this._open();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve(true); // ここで保存が確定
      tx.onerror = tx.onabort = () => resolve(false);
    });
  }

  /**
   * 保存データを読み込む（形式は問わず、そのまま返す）。
   * IndexedDBとlocalStorageのうち新しい方を使う。何もなければ null。
   */
  async load() {
    const fromIdb = await this._get('state');
    let fromLs = null;
    try {
      fromLs = JSON.parse(localStorage.getItem(this.lsKey) ?? 'null');
    } catch {}
    const ok = (s) => s && s.app === APP_ID && ((s.owned && typeof s.owned === 'object') || (s.records && typeof s.records === 'object'));
    const cands = [fromIdb, fromLs].filter(ok);
    if (!cands.length) return null;
    cands.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return cands[0];
  }

  /** 保存する。どちらか一方でも保存できれば成功 */
  async save(state) {
    const s = { ...state, updatedAt: new Date().toISOString() };
    const idb = await this._put('state', s);
    let ls = false;
    try {
      localStorage.setItem(this.lsKey, JSON.stringify(s));
      ls = true;
    } catch {}
    if (!idb && !ls) throw new Error('この端末に保存できませんでした。');
    return { state: s, idb, ls };
  }

  /**
   * 4カット方式へ移行する前のデータを、上書きされない専用の場所に保管する。
   * すでに保管済みなら最初のものを残す。どちらか一方でも保管できれば true。
   */
  async savePreV2Backup(raw) {
    const entry = { at: new Date().toISOString(), state: raw };
    let idb = (await this._get('pre_v2_backup')) !== undefined;
    if (!idb) idb = await this._put('pre_v2_backup', entry);
    let ls = false;
    try {
      if (!localStorage.getItem(this.lsPreV2)) localStorage.setItem(this.lsPreV2, JSON.stringify(entry));
      ls = true;
    } catch {}
    return idb || ls;
  }

  async preV2Backup() {
    const fromIdb = await this._get('pre_v2_backup');
    if (fromIdb) return fromIdb;
    try {
      return JSON.parse(localStorage.getItem(this.lsPreV2) ?? 'null');
    } catch {
      return null;
    }
  }

  /** 復元の直前など、置き換える前のデータを最大5件残す */
  async keepHistory(state, reason) {
    const list = (await this._get('history')) ?? [];
    list.unshift({ at: new Date().toISOString(), reason, state });
    await this._put('history', list.slice(0, 5));
  }

  async history() {
    return (await this._get('history')) ?? [];
  }
}
