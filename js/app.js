// きらりんフォトコレクション（Web版）— 画面
import {
  CUTS, CUT_COUNT, Store, exportBackup, isOwned, missingList, normalize, parseBackup,
  seriesStats, toggleOwned, totals, upgradeState,
} from './core.js';

const $ = (sel) => document.querySelector(sel);
const main = $('#main');
const searchInput = $('#search');

// テスト用に別の保存先を使えるようにする（test_ で始まる名前のみ）
const dbParam = new URLSearchParams(location.search).get('db');
const store = new Store(dbParam && /^test_[\w-]{1,40}$/.test(dbParam) ? dbParam : 'kirari_photo_collection');

const app = {
  seed: null,
  series: [],
  byId: new Map(),
  state: null,
  query: '',
  category: 'all',
  year: 'all',
  status: 'all',
  listScroll: 0,
  lastSavedAt: null,
  saveError: null,
  persisted: null,
  /** 移行前バックアップを保管できなかったときは、保存データを上書きしない */
  saveBlocked: false,
  migratedNow: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ---------- 保存（操作のたびに自動保存。順番どおりに1件ずつ書き込む） ----------

let saveChain = Promise.resolve();
function commit(next, message) {
  if (next === app.state) return saveChain;
  if (app.saveBlocked) {
    toast('⚠ 移行前のデータを保管できなかったため、保存を止めています。「保存・設定」をご確認ください。');
    return saveChain;
  }
  app.state = next;
  render();
  saveChain = saveChain.then(async () => {
    try {
      const r = await store.save(app.state);
      app.lastSavedAt = r.state.updatedAt;
      app.saveError = null;
      if (message) toast(message);
    } catch (e) {
      app.saveError = e.message;
      toast('⚠ 保存できませんでした。バックアップを作成してください。');
    }
  });
  return saveChain;
}

// ---------- 通知・ダイアログ ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function dialog({ title, message = '', ok = 'OK', cancel = 'キャンセル', danger = false }) {
  const dlg = $('#dialog');
  if (typeof dlg.showModal !== 'function') {
    // 古いブラウザ向け
    return Promise.resolve(cancel ? confirm(`${title}\n\n${message}`) : (alert(`${title}\n\n${message}`), true));
  }
  dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
    <div class="actions">${cancel ? `<button class="btn" value="cancel">${esc(cancel)}</button>` : ''}
    <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// ---------- 画面の部品 ----------

function rateLine(st) {
  return `${st.complete ? '<span class="complete-badge">COMPLETE</span>' : ''}<span class="rate">コンプ率 ${st.rate}%</span>
    <span class="mini">（${st.owned}／${st.total}種類）</span>
    <div class="bar${st.complete ? ' done' : ''}"><span style="width:${st.rate}%"></span></div>`;
}

function seriesCard(s) {
  const st = seriesStats(app.state, s.id);
  return `<a class="card${st.complete ? ' complete' : ''}" href="#/s/${encodeURIComponent(s.id)}">
    <div class="name">${esc(s.name)}</div>
    <div><span class="tag">${esc(s.id)}</span><span class="tag">${esc(s.category)}</span>${s.release_year ? `<span class="tag">${esc(s.release_year)}年</span>` : ''}</div>
    <div class="cardrate">${rateLine(st)}</div>
  </a>`;
}

function filtered() {
  const q = normalize(app.query);
  return app.series.filter((s) => {
    if (q && !normalize(`${s.name} ${s.id}`).includes(q)) return false;
    if (app.category !== 'all' && s.category !== app.category) return false;
    if (app.year !== 'all' && String(s.release_year) !== app.year) return false;
    const st = seriesStats(app.state, s.id);
    if (app.status === 'complete' && !st.complete) return false;
    if (app.status === 'incomplete' && st.complete) return false;
    if (app.status === 'zero' && st.owned !== 0) return false;
    return true;
  });
}

// ---------- 一覧（ホーム） ----------

function renderList() {
  const t = totals(app.series, app.state);
  const categories = [...new Set(app.series.map((s) => s.category))];
  const years = [...new Set(app.series.map((s) => s.release_year).filter((y) => y))].sort();
  const chips = [['all', 'すべて'], ['complete', 'COMPLETE'], ['incomplete', '未コンプ'], ['zero', '0%']];
  const showInstall = isIos && !isStandalone && !sessionStorage.getItem('hideInstall');
  main.innerHTML = `
    ${showInstall ? `<div class="note">📱 Safariの共有ボタン（□↑）→「ホーム画面に追加」で、アプリのように使えます。<a href="#/settings">くわしく</a>
      <button class="btn small" data-act="hide-install" style="margin-left:6px">閉じる</button></div>` : ''}
    ${app.migratedNow ? `<div class="note">✓ 4カット方式（ヨリ・チュウ・ヒキ・座り）に移行しました。これまでの所持チェックは引き継いでいます。${app.migratedNow.legacy.length ? `<br>4カット以外のカット ${app.migratedNow.legacy.length}件は削除せず保管しています（集計対象外）。<a href="#/settings">確認する</a>` : ''}</div>` : ''}
    ${app.saveBlocked ? '<div class="note warn">⚠ 移行前のデータを保管できなかったため、保存を止めています。「保存・設定」からバックアップを作成してください。</div>' : ''}
    <div class="stat overall">
      <div class="l">全体コンプリート率</div>
      <div class="v">${t.rate.toFixed(1)}<small>%</small></div>
      <div class="bar${t.owned === t.total ? ' done' : ''}"><span style="width:${t.rate}%"></span></div>
      <div class="l">${t.owned}／${t.total}種類（${t.seriesCount}シリーズ×${CUT_COUNT}種類）</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${t.seriesCount}</div><div class="l">登録シリーズ数</div></div>
      <div class="stat"><div class="v">${t.complete}</div><div class="l">COMPLETEシリーズ</div></div>
      <div class="stat"><div class="v">${t.owned}</div><div class="l">所持種類数</div></div>
      <div class="stat"><div class="v">${t.missing}</div><div class="l">未所持種類数</div></div>
    </div>
    ${app.saveError ? `<div class="note warn">⚠ ${esc(app.saveError)} 「保存・設定」からバックアップを作成してください。</div>` : ''}
    <div class="filters">
      <select id="f-category" aria-label="カテゴリー">
        <option value="all">すべてのカテゴリー</option>
        ${categories.map((c) => `<option value="${esc(c)}"${app.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      ${years.length ? `<select id="f-year" aria-label="年代"><option value="all">すべての年</option>
        ${years.map((y) => `<option value="${y}"${app.year === String(y) ? ' selected' : ''}>${y}年</option>`).join('')}</select>` : ''}
    </div>
    <div class="chips" role="group" aria-label="表示の絞り込み">
      ${chips.map(([k, l]) => `<button class="chip" data-status="${k}" aria-pressed="${app.status === k}">${l}</button>`).join('')}
    </div>
    <p class="count" id="count"></p>
    <div class="cards" id="cards"></div>`;
  fillCards();
}

function fillCards() {
  const list = filtered();
  $('#count').textContent = `${list.length}件を表示／全${app.series.length}件`;
  $('#cards').innerHTML = list.length ? list.map(seriesCard).join('') : '<p class="empty">条件に一致するシリーズがありません。</p>';
}

// ---------- 所持チェック ----------

function renderSeries(id) {
  const s = app.byId.get(id);
  if (!s) {
    main.innerHTML = '<p class="empty">シリーズが見つかりませんでした。</p><a class="btn block" href="#/">一覧へ戻る</a>';
    return;
  }
  const st = seriesStats(app.state, id);
  const legacy = app.state.legacy[id] ?? [];
  main.innerHTML = `
    <a class="back" href="#/">← シリーズ一覧</a>
    <div><span class="tag">${esc(s.id)}</span><span class="tag">${esc(s.category)}</span>${s.release_year ? `<span class="tag">${esc(s.release_year)}年</span>` : ''}${s.status && s.status !== '未照合' ? `<span class="tag warn">${esc(s.status)}</span>` : ''}</div>
    <h1 class="title">${esc(s.name)}</h1>
    ${s.notes ? `<p class="mini">元データの補足：${esc(s.notes)}</p>` : ''}
    <div class="panel">${rateLine(st)}</div>
    <div class="cutlist">
      ${CUTS.map((c) => {
        const owned = isOwned(app.state, id, c.key);
        return `<button class="cut${owned ? ' owned' : ''}" data-act="toggle" data-cut="${c.key}" aria-pressed="${owned}">
          <span class="box" aria-hidden="true">${owned ? '✓' : ''}</span>
          <span class="label">${esc(c.label)}</span>
          <span class="state">${owned ? '所持' : '未所持'}</span>
        </button>`;
      }).join('')}
    </div>
    <p class="mini">タップで「所持／未所持」を切り替えます。変更は自動で保存されます。</p>
    ${legacy.length ? `<div class="panel">
      <h3 style="margin:0 0 4px;font-size:15px">移行前のカット（集計対象外）</h3>
      <p class="mini" style="margin:0 0 8px">4カット方式にする前に登録していたカットです。削除せずに記録として残しています。</p>
      ${legacy.map((c) => `<div class="editrow"><span class="label">${esc(c.label)}</span><span class="tag${c.owned ? ' blue' : ''}">${c.owned ? '所持' : '未所持'}</span></div>`).join('')}
    </div>` : ''}`;
}

// ---------- 未所持一覧 ----------

function renderMissing() {
  const groups = missingList(app.series, app.state);
  const total = groups.reduce((n, g) => n + g.cuts.length, 0);
  main.innerHTML = `
    <h2 style="margin-top:4px">未所持の写真</h2>
    <div class="note">未所持 <strong>${total}種類</strong>（${groups.length}シリーズ）<br>
      各シリーズ ${CUTS.map((c) => c.label).join('・')} の${CUT_COUNT}種類を基準にしています。</div>
    <div class="cards">
      ${groups.length ? groups.map(({ series: s, cuts }) => `<a class="missing-group" href="#/s/${encodeURIComponent(s.id)}">
        <div class="name">${esc(s.name)}</div>
        <div class="cutsline">${cuts.map((c) => `<span class="tag warn">${esc(c.label)}</span>`).join('')}</div>
      </a>`).join('') : '<p class="empty">未所持の写真はありません。全シリーズCOMPLETEです！</p>'}
    </div>`;
}

// ---------- 保存・設定 ----------

function legacyReport() {
  const rows = [];
  for (const [sid, list] of Object.entries(app.state.legacy ?? {})) {
    for (const c of list) rows.push({ s: app.byId.get(sid), sid, c });
  }
  return rows;
}

function renderSettings() {
  const t = totals(app.series, app.state);
  const saved = app.lastSavedAt ?? app.state.updatedAt;
  const persistText = app.persisted === true ? 'このブラウザに「データを自動削除しない」設定が許可されています。'
    : app.persisted === false ? 'ブラウザの空き容量が少なくなると、データが削除される可能性があります。' : '';
  const mig = app.state.migration;
  const legacy = legacyReport();
  main.innerHTML = `<div class="settings">
    <h2 style="margin-top:4px">データの保存について</h2>
    <div class="note warn">
      ・チェック状態は、この端末のブラウザの中に自動保存されます。<br>
      ・<strong>他の端末とは自動で同期されません。</strong>機種変更の際はバックアップファイルで移してください。<br>
      ・ブラウザの履歴・Webサイトデータを削除すると、所持情報も消えます。<br>
      ${isIos ? '・iPhoneでは、Safariで開いたページとホーム画面に追加したアプリは保存場所が別です。ホーム画面のアプリで使い続けてください。<br>' : ''}
      ・大切なデータを守るため、ときどき下の「バックアップを作成」を行ってください。
      ${persistText ? `<br>・${persistText}` : ''}
    </div>
    ${app.saveBlocked ? '<div class="note warn">⚠ 4カット方式への移行前のデータを保管できなかったため、保存を止めています。下の「バックアップを作成」で現在の内容を書き出してから、ページを開き直してください。</div>' : ''}
    <p class="mini">最終保存：${saved ? esc(new Date(saved).toLocaleString('ja-JP')) : 'まだ保存されていません'}
      ／所持 ${t.owned}／${t.total}種類</p>

    <div class="panel">
      <h3>バックアップを作成（JSON）</h3>
      <p class="mini">所持チェックの状態をファイルに書き出します。iPhoneは「共有」→「"ファイル"に保存」がおすすめです。</p>
      <div class="btns">
        ${navigator.canShare ? '<button class="btn primary block" data-act="share">共有メニューから保存</button>' : ''}
        <button class="btn${navigator.canShare ? '' : ' primary'} block" data-act="download">ファイルをダウンロード</button>
      </div>
    </div>

    <div class="panel">
      <h3>バックアップから復元</h3>
      <p class="mini">このWeb版（新旧どちらの形式も可）・HTML試作版・Androidアプリ版のJSONバックアップを読み込めます。旧形式は4カット方式へ移行して取り込みます。現在のデータを置き換える前に、確認画面を表示します。</p>
      <label class="btn block filebtn">ファイルを選んで復元<input type="file" id="restore-file" accept=".json,application/json"></label>
      <button class="btn block" data-act="history" style="margin-top:8px">復元前のデータに戻す</button>
    </div>

    ${mig ? `<div class="panel" id="migration">
      <h3>4カット方式への移行</h3>
      <p class="mini">${esc(new Date(mig.at).toLocaleString('ja-JP'))}に移行しました。ヨリ・チュウ・ヒキ・座りの所持チェックはそのまま引き継いでいます。</p>
      ${legacy.length ? `<p class="mini"><strong>4カット以外のカット ${legacy.length}件</strong>は、削除・付け替えをせずに「移行前のカット（集計対象外）」として保管しています。</p>
        <div>${legacy.map(({ s, sid, c }) => `<div class="editrow"><span class="label">${esc(s?.name ?? sid)}<br><small class="mini">${esc(c.label)}</small></span><span class="tag${c.owned ? ' blue' : ''}">${c.owned ? '所持' : '未所持'}</span></div>`).join('')}</div>`
        : '<p class="mini">移行できなかったカットはありません。</p>'}
      <button class="btn block" data-act="pre-v2" style="margin-top:10px">移行前のデータをダウンロード</button>
    </div>` : ''}

    <div class="panel">
      <h3>iPhoneのホーム画面に追加する</h3>
      <ol class="steps">
        <li>このページを <strong>Safari</strong> で開く</li>
        <li>画面下の共有ボタン（□に↑）をタップ</li>
        <li>「ホーム画面に追加」→「追加」をタップ</li>
        <li>以後はホーム画面の「きらりんフォト」から起動</li>
      </ol>
      <p class="mini">${isStandalone ? '✓ いまはホーム画面のアプリとして開いています。' : 'いまはブラウザで開いています。'}一度開けば、電波のない場所でも使えます。</p>
    </div>

    <div class="panel">
      <h3>収録データ</h3>
      <p class="mini">${esc(app.seed.dataset_title ?? '')}（${esc(app.seed.as_of_date ?? '')}時点）<br>
        シリーズ候補 ${app.series.length}件 × ${CUT_COUNT}種類（${CUTS.map((c) => c.label).join('・')}）＝ ${t.total}種類。${esc(app.seed.basis ?? '')}<br>
        発売年は元データにないため、年代の絞り込みは元データに発売年がある場合だけ表示されます。</p>
    </div>
    <p class="foot">きらりんフォトコレクション Web版 v1.1<br>
      非公式の個人用アプリです。日向坂46運営・メンバー本人とは関係ありません。</p>
  </div>`;
}

// ---------- バックアップ ----------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const backupFile = () => new File([exportBackup(app.state, app.seed)], `kirari_backup_${stamp()}.json`, { type: 'application/json' });

function download(file, message = 'バックアップを書き出しました') {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(message);
}

async function share() {
  const file = backupFile();
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return; // ユーザーがキャンセル
  }
  download(file);
}

async function downloadPreV2() {
  const b = await store.preV2Backup();
  if (!b) return toast('移行前のデータは見つかりませんでした');
  // 旧形式のままの内容（このファイルからも復元できます）
  download(new File([JSON.stringify(b.state, null, 1)], `kirari_before_4cut_${stamp()}.json`, { type: 'application/json' }), '移行前のデータを書き出しました');
}

async function replaceState(next, reason, message) {
  await saveChain;
  await store.keepHistory(app.state, reason);
  app.migratedNow = null;
  await commit(next, message);
}

async function restoreFromText(text, fileName) {
  let parsed;
  try {
    parsed = parseBackup(text, app.series.map((s) => s.id)); // 検証のみ。まだ何も変更しない
  } catch (e) {
    await dialog({ title: '読み込めませんでした', message: `${e.message}\n\n現在のデータは変更していません。`, ok: '閉じる', cancel: null });
    return;
  }
  const cur = totals(app.series, app.state);
  const ok = await dialog({
    title: 'このバックアップで置き換えますか？',
    message: `ファイル：${fileName}\n種類：${parsed.kind}${parsed.exportedAt ? `\n作成日時：${new Date(parsed.exportedAt).toLocaleString('ja-JP')}` : ''}\n` +
      `内容：所持 ${parsed.ownedCount}種類（記録のあるシリーズ ${parsed.seriesCount}件）` +
      `${parsed.legacyCount ? `\n※ 4カット以外のカット ${parsed.legacyCount}件は「移行前のカット」として保管します` : ''}` +
      `${parsed.skipped ? `\n※ 137シリーズ以外の ${parsed.skipped}件は取り込みません` : ''}\n\n` +
      `現在のデータ（所持 ${cur.owned}種類）はすべて置き換わります。置き換え前のデータは「復元前のデータに戻す」から戻せます。`,
    ok: '置き換える',
    danger: true,
  });
  if (!ok) return;
  await replaceState(parsed.state, '復元の直前', '復元しました');
}

async function showHistory() {
  const list = await store.history();
  if (!list.length) {
    await dialog({ title: '復元前のデータ', message: 'まだありません。', ok: '閉じる', cancel: null });
    return;
  }
  const h = list[0];
  const prev = upgradeState(h.state).state; // 古い形式の履歴も4カット方式にそろえる
  const ok = await dialog({
    title: '復元前のデータに戻しますか？',
    message: `${new Date(h.at).toLocaleString('ja-JP')}（${h.reason}）の状態\n所持 ${totals(app.series, prev).owned}種類\n\n現在のデータは置き換わります（現在のデータも履歴に残します）。`,
    ok: '戻す',
    danger: true,
  });
  if (!ok) return;
  await replaceState(prev, '「戻す」の直前', '元に戻しました');
}

// ---------- 画面切り替え ----------

function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/s/')) return { view: 'series', id: decodeURIComponent(h.slice(3)) };
  if (h === '/missing') return { view: 'missing' };
  if (h === '/settings') return { view: 'settings' };
  return { view: 'list' };
}

let currentView = null;
function render() {
  if (!app.state) return;
  const r = route();
  $('#searchwrap').classList.toggle('hidden', r.view !== 'list');
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const tab = a.dataset.tab;
    a.classList.toggle('active', tab === r.view || (tab === 'list' && r.view === 'series'));
  });
  if (r.view === 'list') renderList();
  else if (r.view === 'series') renderSeries(r.id);
  else if (r.view === 'missing') renderMissing();
  else renderSettings();
  currentView = r;
}

window.addEventListener('hashchange', () => {
  const prev = currentView;
  if (prev?.view === 'list') app.listScroll = scrollY;
  render();
  // 一覧へ戻ったときは元の位置へ
  scrollTo(0, currentView.view === 'list' && prev?.view === 'series' ? app.listScroll : 0);
});

searchInput.addEventListener('input', () => {
  app.query = searchInput.value;
  if (route().view === 'list') fillCards();
});

main.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'f-category') { app.category = el.value; fillCards(); }
  else if (el.id === 'f-year') { app.year = el.value; fillCards(); }
  else if (el.id === 'restore-file') {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast('ファイルが大きすぎます');
    restoreFromText(await f.text(), f.name);
  }
});

main.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act], [data-status]');
  if (!b) return;
  if (b.dataset.status) {
    app.status = b.dataset.status;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    return fillCards();
  }
  switch (b.dataset.act) {
    case 'toggle': {
      const id = route().id;
      const cut = CUTS.find((c) => c.key === b.dataset.cut);
      if (cut) commit(toggleOwned(app.state, id, cut.key), `${cut.label}：${isOwned(app.state, id, cut.key) ? '未所持' : '所持'}にしました`);
      break;
    }
    case 'download':
      download(backupFile());
      break;
    case 'share':
      share();
      break;
    case 'history':
      showHistory();
      break;
    case 'pre-v2':
      downloadPreV2();
      break;
    case 'hide-install':
      sessionStorage.setItem('hideInstall', '1');
      render();
      break;
  }
});

// ---------- 起動 ----------

async function start() {
  try {
    const res = await fetch('data/kirari_seed.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    app.seed = await res.json();
    app.series = app.seed.series;
    app.byId = new Map(app.series.map((s) => [s.id, s]));

    const raw = await store.load();
    const { state, report } = upgradeState(raw);
    app.state = state;
    if (report) {
      // 旧形式（カット自由設定）からの移行：先に移行前のデータを専用の場所へ保管してから保存する
      if (await store.savePreV2Backup(raw)) {
        const r = await store.save(state);
        app.state = r.state;
        app.migratedNow = report;
      } else {
        app.saveBlocked = true;
      }
    }
    app.lastSavedAt = app.state.updatedAt;
  } catch (e) {
    main.innerHTML = `<p class="empty">データを読み込めませんでした（${esc(e.message)}）。<br>通信できる場所で開き直してください。保存済みの所持情報は削除していません。</p>`;
    return;
  }
  render();
  document.documentElement.dataset.ready = '1';
  try {
    app.persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
  } catch {}
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();
