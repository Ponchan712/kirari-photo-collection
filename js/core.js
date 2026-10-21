// きらりんフォトコレクション（Web版）— データ・集計・保存・バックアップ
// 画面（app.js）から切り離し、ブラウザでテストできるようにしている。

export const APP_ID = 'kirari-photo-collection-web';
export const FORMAT_VERSION = 1;

/** 入力補助のテンプレート（実際のカット構成を保証するものではない） */
export const PRESETS = {
  three: { label: '3種（ヨリ・チュウ・ヒキ）', cuts: ['ヨリ', 'チュウ', 'ヒキ'] },
  four: { label: '4種（全身・ウエスト・アップ・座り）', cuts: ['全身', 'ウエスト', 'アップ', '座り'] },
};

/**
 * 保存データ
 * records[シリーズID] = { cuts: [{id, label, owned}], confirmed, updatedAt }
 * - records にないシリーズ ＝ カット未設定（所持情報は「未登録」で、未所持とは扱わない）
 * - confirmed ＝ 全カット構成を確定済み（コンプ率はこのときだけ計算）
 */
export function emptyState() {
  return { app: APP_ID, version: FORMAT_VERSION, updatedAt: null, records: {} };
}

export function newCutId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- 集計 ----------

export function seriesStats(record) {
  const cuts = record?.cuts ?? [];
  const owned = cuts.filter((c) => c.owned === true).length;
  const confirmed = !!record?.confirmed && cuts.length > 0;
  return {
    cutCount: cuts.length,
    owned,
    missing: cuts.length - owned,
    configured: cuts.length > 0,
    confirmed,
    rate: confirmed ? Math.floor((owned / cuts.length) * 100) : null, // 未確定なら null
    complete: confirmed && owned === cuts.length,
  };
}

export function totals(seriesList, state) {
  let owned = 0, missing = 0, complete = 0, configured = 0;
  for (const s of seriesList) {
    const st = seriesStats(state.records[s.id]);
    owned += st.owned;
    missing += st.missing;
    if (st.complete) complete++;
    if (st.configured) configured++;
  }
  return { seriesCount: seriesList.length, owned, missing, complete, configured, hasAnyRecord: configured > 0 };
}

/** 未所持のカット一覧（カット未設定のシリーズは含めない） */
export function missingList(seriesList, state) {
  const out = [];
  for (const s of seriesList) {
    const cuts = (state.records[s.id]?.cuts ?? []).filter((c) => !c.owned);
    if (cuts.length) out.push({ series: s, cuts });
  }
  return out;
}

/** 検索用：全角/半角・大文字/小文字・空白の違いを無視 */
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// ---------- 編集（すべて新しいstateを返す） ----------

function touch(state, id, record) {
  const now = new Date().toISOString();
  return { ...state, records: { ...state.records, [id]: { ...record, updatedAt: now } } };
}

export function addCuts(state, id, labels) {
  const rec = state.records[id] ?? { cuts: [], confirmed: false };
  const names = new Set(rec.cuts.map((c) => c.label));
  const added = [];
  for (const raw of labels) {
    const label = String(raw).trim().slice(0, 80);
    if (!label || names.has(label)) continue;
    names.add(label);
    added.push({ id: newCutId(), label, owned: false });
  }
  if (!added.length) return state;
  // カット構成が変わったので「確定」は解除する
  return touch(state, id, { ...rec, cuts: [...rec.cuts, ...added], confirmed: false });
}

export function toggleOwned(state, id, cutId) {
  const rec = state.records[id];
  if (!rec) return state;
  return touch(state, id, { ...rec, cuts: rec.cuts.map((c) => (c.id === cutId ? { ...c, owned: !c.owned } : c)) });
}

export function renameCut(state, id, cutId, label) {
  const rec = state.records[id];
  label = String(label ?? '').trim().slice(0, 80);
  if (!rec || !label || rec.cuts.some((c) => c.label === label && c.id !== cutId)) return state;
  return touch(state, id, { ...rec, cuts: rec.cuts.map((c) => (c.id === cutId ? { ...c, label } : c)) });
}

export function removeCut(state, id, cutId) {
  const rec = state.records[id];
  if (!rec) return state;
  const cuts = rec.cuts.filter((c) => c.id !== cutId);
  if (!cuts.length) {
    const records = { ...state.records };
    delete records[id];
    return { ...state, records };
  }
  return touch(state, id, { ...rec, cuts, confirmed: false });
}

export function moveCut(state, id, cutId, delta) {
  const rec = state.records[id];
  if (!rec) return state;
  const i = rec.cuts.findIndex((c) => c.id === cutId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= rec.cuts.length) return state;
  const cuts = [...rec.cuts];
  [cuts[i], cuts[j]] = [cuts[j], cuts[i]];
  return touch(state, id, { ...rec, cuts });
}

export function setConfirmed(state, id, confirmed) {
  const rec = state.records[id];
  if (!rec || !rec.cuts.length) return state;
  return touch(state, id, { ...rec, confirmed: !!confirmed });
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
      records: state.records,
    },
    null,
    1,
  );
}

/**
 * バックアップファイルを読み込み、検証する（この時点では保存データを変更しない）。
 * 対応形式：このWeb版 / HTML試作版（kirari-photocollection）/ Flutterアプリ版（kirari-photo-collection）
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
  let records, kind;

  if (raw.app === APP_ID) {
    kind = 'このWeb版のバックアップ';
    records = raw.records;
  } else if (raw.app === 'kirari-photocollection' || (raw.version === 1 && raw.collection)) {
    kind = 'HTML試作版のバックアップ';
    records = fromHtmlPrototype(raw.app ? raw.data : raw);
  } else if (raw.app === 'kirari-photo-collection' && raw.tables) {
    kind = 'Androidアプリ版のバックアップ';
    records = fromFlutterApp(raw.tables);
  } else {
    throw new Error('きらりんフォトコレクションのバックアップではありません。');
  }

  const clean = {};
  let skipped = 0;
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('バックアップの中身が壊れています。');
  for (const [id, rec] of Object.entries(records)) {
    if (!known.has(id)) { skipped++; continue; } // 137シリーズ以外（自分で追加したシリーズ等）は取り込まない
    if (!rec || !Array.isArray(rec.cuts) || rec.cuts.length > 300) throw new Error(`「${id}」のデータが壊れています。`);
    const labels = new Set();
    const cuts = [];
    for (const c of rec.cuts) {
      if (!c || typeof c.label !== 'string' || !c.label.trim() || typeof c.owned !== 'boolean') {
        throw new Error(`「${id}」のカットのデータが壊れています。`);
      }
      const label = c.label.trim().slice(0, 80);
      if (labels.has(label)) continue;
      labels.add(label);
      cuts.push({ id: typeof c.id === 'string' && c.id ? c.id : newCutId(), label, owned: c.owned });
    }
    if (!cuts.length) continue;
    clean[id] = { cuts, confirmed: !!rec.confirmed, updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null };
  }
  const st = { ...emptyState(), records: clean };
  const t = Object.values(clean).reduce(
    (a, r) => ({ cuts: a.cuts + r.cuts.length, owned: a.owned + r.cuts.filter((c) => c.owned).length }),
    { cuts: 0, owned: 0 },
  );
  return { kind, state: st, seriesCount: Object.keys(clean).length, cutCount: t.cuts, ownedCount: t.owned, skipped, exportedAt: raw.exportedAt ?? raw.exported_at ?? null };
}

// HTML試作版：所持枚数（qty）1枚以上 → 所持。0枚・未登録 → 未所持
function fromHtmlPrototype(d) {
  if (!d || d.version !== 1 || typeof d.collection !== 'object') throw new Error('HTML試作版のバックアップが壊れています。');
  const out = {};
  for (const [id, r] of Object.entries(d.collection)) {
    if (!r || !Array.isArray(r.cuts)) continue;
    out[id] = {
      cuts: r.cuts.filter((c) => c && typeof c.label === 'string').map((c) => ({ id: String(c.id ?? ''), label: c.label, owned: Number.isInteger(c.qty) && c.qty > 0 })),
      confirmed: r.verified === true,
    };
  }
  return out;
}

// Androidアプリ版：cuts テーブルの qty 1以上 → 所持、series.cuts_verified → 確定
function fromFlutterApp(tables) {
  if (!Array.isArray(tables.series) || !Array.isArray(tables.cuts)) throw new Error('Androidアプリ版のバックアップが壊れています。');
  const verified = new Map(tables.series.map((s) => [s.id, s.cuts_verified === 1]));
  const out = {};
  const cuts = [...tables.cuts].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  for (const c of cuts) {
    if (!c || typeof c.series_id !== 'string' || typeof c.label !== 'string') continue;
    (out[c.series_id] ??= { cuts: [], confirmed: verified.get(c.series_id) === true }).cuts.push({
      id: 'a' + c.id, label: c.label, owned: Number.isInteger(c.qty) && c.qty > 0,
    });
  }
  return out;
}

// ---------- 端末への保存（IndexedDB ＋ localStorage の二重保存） ----------

export class Store {
  constructor(name = 'kirari_photo_collection') {
    this.name = name;
    this.lsKey = name + '__state';
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

  /** 保存データを読み込む。IndexedDBとlocalStorageのうち新しい方を使う */
  async load() {
    const fromIdb = await this._get('state');
    let fromLs = null;
    try {
      fromLs = JSON.parse(localStorage.getItem(this.lsKey) ?? 'null');
    } catch {}
    const ok = (s) => s && s.app === APP_ID && s.records && typeof s.records === 'object';
    const cands = [fromIdb, fromLs].filter(ok);
    if (!cands.length) return emptyState();
    cands.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return cands[0];
  }

  /** 保存する。どちらか一方でも保存できれば true */
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
