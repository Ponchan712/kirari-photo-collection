// きらりんフォトコレクション（Web版）— 画面
import {
  PRESETS, Store, addCuts, exportBackup, missingList, moveCut, normalize, parseBackup,
  removeCut, renameCut, seriesStats, setConfirmed, toggleOwned, totals,
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
  editing: false,
  listScroll: 0,
  lastSavedAt: null,
  saveError: null,
  persisted: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ---------- 保存（操作のたびに自動保存。順番どおりに1件ずつ書き込む） ----------

let saveChain = Promise.resolve();
function commit(next, message) {
  if (next === app.state) return;
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

function dialog({ title, message = '', ok = 'OK', cancel = 'キャンセル', danger = false, input = null }) {
  const dlg = $('#dialog');
  if (typeof dlg.showModal !== 'function') {
    // 古いブラウザ向け
    if (input !== null) return Promise.resolve(prompt(`${title}\n${message}`, input));
    return Promise.resolve(cancel ? confirm(`${title}\n\n${message}`) : (alert(`${title}\n\n${message}`), true));
  }
  dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
    ${input !== null ? `<input type="text" name="v" maxlength="80" value="${esc(input)}" autocomplete="off">` : ''}
    <div class="actions">${cancel ? `<button class="btn" value="cancel">${esc(cancel)}</button>` : ''}
    <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const okd = dlg.returnValue === 'ok';
      resolve(input !== null ? (okd ? dlg.querySelector('input').value.trim() : null) : okd);
    };
    dlg.returnValue = '';
    dlg.showModal();
    dlg.querySelector('input')?.select();
  });
}

// ---------- 画面の部品 ----------

function statusBadges(st) {
  if (!st.configured) return '<span class="tag">カット未設定</span>';
  if (st.complete) return '<span class="complete-badge">COMPLETE</span>';
  if (!st.confirmed) return `<span class="tag warn">所持 ${st.owned}/${st.cutCount}・コンプ率未確定</span>`;
  return `<span class="tag blue">${st.owned}/${st.cutCount}種類・${st.rate}%</span>`;
}

function seriesCard(s) {
  const st = seriesStats(app.state.records[s.id]);
  const sub = !st.configured ? '所持情報：未登録（カットを設定すると記録できます）'
    : `所持 ${st.owned}種類・未所持 ${st.missing}種類`;
  return `<a class="card${st.complete ? ' complete' : ''}" href="#/s/${encodeURIComponent(s.id)}">
    <div class="name">${esc(s.name)}</div>
    <div><span class="tag">${esc(s.id)}</span><span class="tag">${esc(s.category)}</span>${s.release_year ? `<span class="tag">${esc(s.release_year)}年</span>` : ''}${statusBadges(st)}</div>
    <div class="sub">${esc(sub)}</div>
    ${st.confirmed ? `<div class="bar${st.complete ? ' done' : ''}"><span style="width:${st.rate}%"></span></div>` : ''}
  </a>`;
}

function filtered() {
  const q = normalize(app.query);
  return app.series.filter((s) => {
    if (q && !normalize(`${s.name} ${s.id}`).includes(q)) return false;
    if (app.category !== 'all' && s.category !== app.category) return false;
    if (app.year !== 'all' && String(s.release_year) !== app.year) return false;
    const st = seriesStats(app.state.records[s.id]);
    if (app.status === 'complete' && !st.complete) return false;
    if (app.status === 'missing' && !(st.missing > 0)) return false;
    if (app.status === 'unset' && st.configured) return false;
    if (app.status === 'unconfirmed' && (!st.configured || st.confirmed)) return false;
    return true;
  });
}

// ---------- 一覧 ----------

function renderList() {
  const t = totals(app.series, app.state);
  const val = (n) => (t.hasAnyRecord ? `<div class="v">${n}</div>` : '<div class="v unset">未登録</div>');
  const categories = [...new Set(app.series.map((s) => s.category))];
  const years = [...new Set(app.series.map((s) => s.release_year).filter((y) => y))].sort();
  const chips = [['all', 'すべて'], ['complete', 'COMPLETE'], ['missing', '未所持あり'], ['unconfirmed', 'カット未確定'], ['unset', 'カット未設定']];
  const showInstall = isIos && !isStandalone && !sessionStorage.getItem('hideInstall');
  main.innerHTML = `
    ${showInstall ? `<div class="note">📱 Safariの共有ボタン（□↑）→「ホーム画面に追加」で、アプリのように使えます。<a href="#/settings">くわしく</a>
      <button class="btn small" data-act="hide-install" style="margin-left:6px">閉じる</button></div>` : ''}
    <div class="stats">
      <div class="stat"><div class="v">${t.seriesCount}</div><div class="l">登録シリーズ数</div></div>
      <div class="stat">${val(t.owned)}<div class="l">所持種類数</div></div>
      <div class="stat">${val(t.missing)}<div class="l">未所持種類数</div></div>
      <div class="stat"><div class="v">${t.complete}</div><div class="l">コンプリート済みシリーズ</div></div>
    </div>
    ${t.hasAnyRecord ? `<p class="mini">カットを設定したシリーズ ${t.configured}件の集計です。カット未設定のシリーズは「未登録」として、未所持には含めていません。</p>`
      : '<p class="mini">まだ所持情報が登録されていません。シリーズを開いてカットを設定し、所持しているカットをタップしてください。</p>'}
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
  const rec = app.state.records[id];
  const st = seriesStats(rec);
  const cuts = rec?.cuts ?? [];
  let rateHtml;
  if (!st.configured) rateHtml = '<div class="rate unset">カット未設定のため、所持情報は未登録です</div>';
  else if (!st.confirmed) rateHtml = `<div class="rate unset">コンプ率：未確定</div><div class="mini">所持 ${st.owned}／${st.cutCount}カット。全カットが確定したら下の「カット構成を確定」をオンにしてください。</div>`;
  else rateHtml = `${st.complete ? '<span class="complete-badge">COMPLETE</span>' : ''}<div class="rate">コンプ率 ${st.rate}%（${st.owned}／${st.cutCount}種類）</div>
    <div class="bar${st.complete ? ' done' : ''}"><span style="width:${st.rate}%"></span></div>`;

  main.innerHTML = `
    <a class="back" href="#/">← シリーズ一覧</a>
    <div><span class="tag">${esc(s.id)}</span><span class="tag">${esc(s.category)}</span>${s.release_year ? `<span class="tag">${esc(s.release_year)}年</span>` : ''}${s.status && s.status !== '未照合' ? `<span class="tag warn">${esc(s.status)}</span>` : ''}</div>
    <h1 class="title">${esc(s.name)}</h1>
    ${s.notes ? `<p class="mini">元データの補足：${esc(s.notes)}</p>` : ''}
    <div class="panel">${rateHtml}</div>

    ${cuts.length ? `<div class="cutlist">
      ${cuts.map((c) => `<button class="cut${c.owned ? ' owned' : ''}" data-act="toggle" data-cut="${esc(c.id)}" aria-pressed="${c.owned}">
          <span class="box" aria-hidden="true">${c.owned ? '✓' : ''}</span>
          <span class="label">${esc(c.label)}</span>
          <span class="state">${c.owned ? '所持' : '未所持'}</span>
        </button>`).join('')}
      </div>
      <p class="mini">タップで「所持／未所持」を切り替えます。変更は自動で保存されます。</p>
      <div class="panel">
        <label class="check"><input type="checkbox" data-act="confirm" ${st.confirmed ? 'checked' : ''}>
          <span>カット構成を確定（全${cuts.length}種類）<small>このシリーズのカットの種類がすべてそろったらオンにします。オンのときだけコンプ率を計算します。カットを追加・削除すると自動でオフに戻ります。</small></span></label>
      </div>`
    : `<div class="panel">
        <h3 style="margin:0 0 4px">カットを設定してください</h3>
        <p class="mini" style="margin:0 0 10px">元データにカットの情報がないため、まだ登録していません。テンプレートは入力の補助で、実際の構成を保証するものではありません。</p>
        <div class="btns">
          ${Object.entries(PRESETS).map(([k, p]) => `<button class="btn primary block" data-act="preset" data-preset="${k}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>`}

    <div class="panel">
      ${cuts.length ? `<button class="btn block" data-act="edit">${app.editing ? '編集を終える' : '✎ カットの追加・名前変更・削除'}</button>` : ''}
      ${app.editing || !cuts.length ? `
        ${cuts.map((c, i) => `<div class="editrow"><span class="label">${esc(c.label)}</span>
          <button class="btn small" data-act="up" data-cut="${esc(c.id)}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
          <button class="btn small" data-act="down" data-cut="${esc(c.id)}" ${i === cuts.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
          <button class="btn small" data-act="rename" data-cut="${esc(c.id)}" aria-label="名前を変更">✎</button>
          <button class="btn small danger" data-act="remove" data-cut="${esc(c.id)}" aria-label="削除">✕</button></div>`).join('')}
        <form class="row" id="addcut" style="margin-top:10px">
          <input type="text" name="label" maxlength="200" placeholder="カット名（「、」区切りで複数可）" autocomplete="off" aria-label="追加するカット名">
          <button class="btn primary" type="submit">追加</button>
        </form>
        <p class="mini">例：「ヨリ、チュウ、ヒキ」「A、B、C、D、E、F、G、H」（8種類なども可）</p>` : ''}
    </div>`;
}

// ---------- 未所持一覧 ----------

function renderMissing() {
  const groups = missingList(app.series, app.state);
  const unset = app.series.filter((s) => !seriesStats(app.state.records[s.id]).configured).length;
  const total = groups.reduce((n, g) => n + g.cuts.length, 0);
  main.innerHTML = `
    <h2 style="margin-top:4px">未所持の写真</h2>
    <div class="note">未所持 <strong>${total}種類</strong>（${groups.length}シリーズ）<br>
      カット未設定の ${unset}シリーズは所持情報が「未登録」のため、ここには含めていません。</div>
    <div class="cards">
      ${groups.length ? groups.map(({ series: s, cuts }) => `<a class="missing-group" href="#/s/${encodeURIComponent(s.id)}">
        <div class="name">${esc(s.name)}</div>
        <div class="cutsline">${cuts.map((c) => `<span class="tag warn">${esc(c.label)}</span>`).join('')}</div>
      </a>`).join('') : '<p class="empty">未所持として記録された写真はありません。</p>'}
    </div>`;
}

// ---------- 保存・設定 ----------

function renderSettings() {
  const t = totals(app.series, app.state);
  const saved = app.lastSavedAt ?? app.state.updatedAt;
  const persistText = app.persisted === true ? 'このブラウザに「データを自動削除しない」設定が許可されています。'
    : app.persisted === false ? 'ブラウザの空き容量が少なくなると、データが削除される可能性があります。' : '';
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
    <p class="mini">最終保存：${saved ? esc(new Date(saved).toLocaleString('ja-JP')) : 'まだ保存されていません'}
      ／カット設定済み ${t.configured}シリーズ</p>

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
      <p class="mini">このWeb版・HTML試作版・Androidアプリ版のJSONバックアップを読み込めます。現在のデータを置き換える前に、確認画面を表示します。</p>
      <label class="btn block filebtn">ファイルを選んで復元<input type="file" id="restore-file" accept=".json,application/json"></label>
      <button class="btn block" data-act="history" style="margin-top:8px">復元前のデータに戻す</button>
    </div>

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
        シリーズ候補 ${app.series.length}件。${esc(app.seed.basis ?? '')}<br>
        発売年・カット構成は元データにないため、推測で補っていません（年代の絞り込みは、元データに発売年がある場合だけ表示されます）。</p>
    </div>
    <p class="foot">きらりんフォトコレクション Web版 v1.0<br>
      非公式の個人用アプリです。日向坂46運営・メンバー本人とは関係ありません。</p>
  </div>`;
}

// ---------- バックアップ ----------

function backupFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `kirari_backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
  return new File([exportBackup(app.state, app.seed)], name, { type: 'application/json' });
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('バックアップを書き出しました');
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
      `内容：カット設定済み ${parsed.seriesCount}シリーズ・${parsed.cutCount}カット（所持 ${parsed.ownedCount}）` +
      `${parsed.skipped ? `\n※ 137シリーズ以外の ${parsed.skipped}件は取り込みません` : ''}\n\n` +
      `現在のデータ（カット設定済み ${cur.configured}シリーズ）はすべて置き換わります。置き換え前のデータは「復元前のデータに戻す」から戻せます。`,
    ok: '置き換える',
    danger: true,
  });
  if (!ok) return;
  await saveChain;
  await store.keepHistory(app.state, '復元の直前');
  await commit(parsed.state, '復元しました');
}

async function showHistory() {
  const list = await store.history();
  if (!list.length) {
    await dialog({ title: '復元前のデータ', message: 'まだありません。', ok: '閉じる', cancel: null });
    return;
  }
  const h = list[0];
  const n = Object.keys(h.state.records ?? {}).length;
  const ok = await dialog({
    title: '復元前のデータに戻しますか？',
    message: `${new Date(h.at).toLocaleString('ja-JP')}（${h.reason}）の状態\nカット設定済み ${n}シリーズ\n\n現在のデータは置き換わります（現在のデータも履歴に残します）。`,
    ok: '戻す',
    danger: true,
  });
  if (!ok) return;
  await saveChain;
  await store.keepHistory(app.state, '「戻す」の直前');
  await commit({ ...h.state }, '元に戻しました');
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
  app.editing = false;
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
  else if (el.dataset.act === 'confirm') {
    const id = route().id;
    commit(setConfirmed(app.state, id, el.checked), el.checked ? 'カット構成を確定しました' : 'コンプ率を未確定に戻しました');
  } else if (el.id === 'restore-file') {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast('ファイルが大きすぎます');
    restoreFromText(await f.text(), f.name);
  }
});

main.addEventListener('submit', (e) => {
  if (e.target.id !== 'addcut') return;
  e.preventDefault();
  const id = route().id;
  const labels = String(new FormData(e.target).get('label') ?? '').split(/[、,，\n／/]/);
  const next = addCuts(app.state, id, labels);
  if (next === app.state) return toast('追加するカットがありません（同じ名前は追加できません）');
  commit(next, 'カットを追加しました');
});

main.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act], [data-status]');
  if (!b) return;
  if (b.dataset.status) {
    app.status = b.dataset.status;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    return fillCards();
  }
  const id = route().id;
  const cutId = b.dataset.cut;
  const cut = app.state.records[id]?.cuts.find((c) => c.id === cutId);
  switch (b.dataset.act) {
    case 'toggle':
      if (cut) commit(toggleOwned(app.state, id, cutId), `${cut.label}：${cut.owned ? '未所持' : '所持'}にしました`);
      break;
    case 'preset':
      commit(addCuts(app.state, id, PRESETS[b.dataset.preset].cuts), 'カットを設定しました。実際の構成と合っているか確認してください');
      break;
    case 'edit':
      app.editing = !app.editing;
      render();
      break;
    case 'up':
    case 'down':
      commit(moveCut(app.state, id, cutId, b.dataset.act === 'up' ? -1 : 1));
      break;
    case 'rename': {
      if (!cut) break;
      const v = await dialog({ title: 'カット名の変更', input: cut.label, ok: '変更' });
      if (v && v !== cut.label) {
        const next = renameCut(app.state, id, cutId, v);
        next === app.state ? toast('同じ名前のカットがあります') : commit(next, 'カット名を変更しました（所持状態はそのままです）');
      }
      break;
    }
    case 'remove': {
      if (!cut) break;
      const ok = await dialog({ title: `「${cut.label}」を削除`, message: 'このカットと所持チェックを削除します。', ok: '削除する', danger: true });
      if (ok) commit(removeCut(app.state, id, cutId), 'カットを削除しました');
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
    app.state = await store.load();
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
