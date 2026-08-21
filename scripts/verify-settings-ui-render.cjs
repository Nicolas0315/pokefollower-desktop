// 設定ウィンドウ（src/settings/*）を実 Electron の BrowserWindow で描画し、
// タブ切替・グリッド・検索・世代/タイプフィルタ・スライダー換算・手持ち操作の
// 「実際の挙動」を検証する。
//
// verify-settings-ui.cjs は HTML/JS のソース文字列契約（ID の存在など）を見るだけで、
// ハンドラの結線ミス・状態遷移・数値換算の誤りは検出できない。ここはその穴を埋める。
//
// 構成は verify-notification-overlay-render.cjs と同じ self-re-exec パターン。
// 依存追加なし（同梱の electron をそのまま使う）。
//
// PF_UI_SHOTS_DIR を指定すると、各タブの PNG も書き出す（高解像度は PF_UI_SHOT_SCALE）。
//
// 高解像度化は「contentSize を N 倍 ＋ ロード後に setZoomFactor(N)」で行う。
// CSS px のビューポートは 420x760 のまま（＝実物と同じレイアウト）で devicePixelRatio だけ
// N 倍になる。--force-device-scale-factor は macOS では無視される（実測）ため使わない。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const shotsDir = process.env.PF_UI_SHOTS_DIR || "";
const shotScale = Math.max(1, Number(process.env.PF_UI_SHOT_SCALE || "1") || 1);
const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 760;

function fail(message) {
  throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectTrue(condition, label) {
  if (!condition) fail(label);
}

// ─── 実 Electron 側 ───────────────────────────────────────────────
async function runElectronMain() {
  const { app, BrowserWindow, ipcMain, protocol, net } = require("electron");
  const { pathToFileURL } = require("node:url");
  const { resolveAppProtocolPath } = require("../src/main/app-protocol-path.js");
  const { makePackReader } = require("../src/main/pack-reader.js");

  // zoom レベルは userData に origin 単位で永続化される。既定の共有 userData を使うと
  // ここで設定した拡大率が他の Electron 実行（verify:notification や dev 起動）へ漏れる。
  // 実行ごとに捨てる userData を与えて隔離する。
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-settings-ui-render-"));
  app.setPath("userData", userDataDir);
  app.on("will-quit", () => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); }
    catch (_) { /* 終了時のクリーンアップ失敗は無視 */ }
  });

  const packReader = makePackReader(root);
  const packs = packReader.readPackList();
  const formCount = packs.filter((p) => p.region).length;
  const normalCount = packs.length - formCount;

  // 実 main.js と同じ既定に寄せた固定 settings。相棒は #009 ゼニガメ系（既定値）。
  const HERO_PACK = "retro/gen-1/009-blastoise";
  let settings = {
    enabled: true,
    pack: HERO_PACK,
    favoritePacks: [HERO_PACK],
    rotationEnabled: false,
    rotationIntervalMinutes: 15,
    scale: 1.25,
    offset: 70,
    lerp: 0.2,
    edgeRest: false,
    avoidCursor: true,
    avoidCursorStrength: "normal",
    personality: "standard",
    mode: "follow",
    appReactionsEnabled: false,
    notificationCompanionEnabled: false,
    workWatchEnabled: false,
    workWatchPreset: "25/5",
    nicknames: {},
  };
  // renderer が送ってきた settings:set patch を全部記録する（契約の検証対象）。
  const patches = [];

  ipcMain.handle("settings:get", () => settings);
  ipcMain.on("settings:set", (_event, patch) => {
    patches.push(patch);
    settings = { ...settings, ...patch };
  });
  ipcMain.handle("packs:list", () => packs);
  ipcMain.handle("packs:search-metadata", () => packReader.readSearchMetadata());
  ipcMain.handle("packs:meta", (_event, packKey) => {
    try { return packReader.readPackMeta(packKey); }
    catch (_) { return null; }
  });
  ipcMain.handle("nickname:set", (_event, payload) => {
    const nicknames = { ...settings.nicknames };
    if (payload && typeof payload.name === "string" && payload.name.trim()) nicknames[payload.packKey] = payload.name.trim();
    else if (payload) delete nicknames[payload.packKey];
    settings = { ...settings, nicknames };
    return settings;
  });
  ipcMain.handle("party:set-lead", (_event, packKey) => {
    const rest = (settings.favoritePacks || []).filter((id) => id !== packKey);
    settings = { ...settings, pack: packKey, favoritePacks: [packKey, ...rest] };
    return settings;
  });
  ipcMain.handle("update:get-version", () => "1.4.0");
  ipcMain.handle("update:check", () => ({ status: "up-to-date" }));
  for (const channel of [
    "companion:test-notification",
    "work-watch:start",
    "work-watch:stop",
    "work-watch:reset",
    "favorites:next",
    "favorites:add",
    "favorites:remove",
    "codex-pet:export-current",
  ]) {
    ipcMain.handle(channel, () => null);
  }

  await app.whenReady();

  // タイル画像・スプライトは app://bundle/assets/... 経由。実 main.js と同じ解決器を使う。
  protocol.handle("app", (request) => {
    const filePath = resolveAppProtocolPath(root, request.url);
    if (!filePath) return new Response(null, { status: 403 });
    if (!fs.existsSync(filePath)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({
    width: WINDOW_WIDTH * shotScale,
    height: WINDOW_HEIGHT * shotScale,
    useContentSize: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(root, "src", "settings", "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const consoleErrors = [];
  win.webContents.on("console-message", (event) => {
    // Electron 42: event.level は "error" | "warning" | ... 画像 404 は無視する。
    if (event.level !== "error") return;
    const text = String(event.message || "");
    if (/ERR_FILE_NOT_FOUND|Failed to load resource/.test(text)) return;
    consoleErrors.push(text);
  });

  await win.loadFile(path.join(root, "src", "settings", "settings.html"));
  // setZoomFactor はナビゲーション後に当てる（load 前だと遷移でリセットされる）。
  if (shotScale !== 1) win.webContents.setZoomFactor(shotScale);

  const evalPage = (js) => win.webContents.executeJavaScript(js, true);

  async function waitFor(js, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await evalPage(js)) return;
      if (Date.now() > deadline) fail(`timeout waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // settings.js は await 連鎖のあと buildGrid() する。グリッド生成完了を待つ。
  await waitFor(`document.querySelectorAll("#grid .tile").length > 0`, "grid to build");
  await waitFor(`!!document.getElementById("heroName").textContent.trim()`, "hero to render");

  const visibleCount = () => evalPage(`document.querySelectorAll("#grid .tile:not(.hidden)").length`);
  async function setSearch(value) {
    await evalPage(`(() => {
      const el = document.getElementById("search");
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }
  async function click(selector) {
    await evalPage(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("no element for " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  async function commitNumber(id, value) {
    const before = patches.length;
    await evalPage(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    for (let i = 0; i < 40 && patches.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (patches.length === before) fail(`${id}: change did not emit a settings:set patch`);
    return patches[patches.length - 1];
  }

  const checks = [];
  const record = (name) => checks.push(name);

  // ── 1. 初期タブ状態 ───────────────────────────────────────────
  {
    const state = await evalPage(`(() => ({
      aibouHidden: document.getElementById("panel-aibou").hidden,
      boxHidden: document.getElementById("panel-box").hidden,
      settingsHidden: document.getElementById("panel-settings").hidden,
      selected: [...document.querySelectorAll("#tabs .tab")].filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.dataset.tab),
    }))()`);
    expectEqual(state.aibouHidden, false, "初期表示: あいぼうパネルが可視");
    expectEqual(state.boxHidden, true, "初期表示: ボックスパネルが非表示");
    expectEqual(state.settingsHidden, true, "初期表示: せっていパネルが非表示");
    expectEqual(state.selected.join(","), "aibou", "初期表示: aria-selected はあいぼうのみ");
    record("初期タブ状態");
  }

  // ── 2. グリッド件数と dataset ────────────────────────────────
  {
    const grid = await evalPage(`(() => {
      const tiles = [...document.querySelectorAll("#grid .tile")];
      return {
        total: tiles.length,
        withGen: tiles.filter((t) => t.dataset.gen && t.dataset.gen !== "0").length,
        withSearch: tiles.filter((t) => (t.dataset.search || "").length > 0).length,
        forms: tiles.filter((t) => t.dataset.region).length,
      };
    })()`);
    expectEqual(grid.total, packs.length, "グリッド: 全パック分のタイルが生成される");
    expectEqual(grid.forms, formCount, "グリッド: 地方フォルムのタイル数");
    expectEqual(grid.withSearch, packs.length, "グリッド: 全タイルに検索テキストが載る");
    expectTrue(grid.withGen >= normalCount, "グリッド: 通常パックに世代が載る");
    // 初期描画でも applyFilter() が走ること。ここが抜けると kind="通常" のまま
    // 地方フォルムが出たままになり、検索欄に触れた瞬間に 54 件消える（回帰防止）。
    expectEqual(await visibleCount(), normalCount, "初期フィルタ: kind=normal では通常パックのみ可視");
    record(`グリッド ${grid.total}件（可視 ${normalCount} / フォルム ${formCount}）`);
  }

  // ── 3. あいぼうヒーロー表示 ─────────────────────────────────
  {
    const hero = await evalPage(`(() => ({
      name: document.getElementById("heroName").textContent.trim(),
      num: document.getElementById("heroNum").textContent.trim(),
      typeChips: [...document.getElementById("heroTypes").children].map((c) => ({ text: c.textContent, bg: getComputedStyle(c).backgroundColor })),
      spriteImage: getComputedStyle(document.getElementById("heroSprite")).backgroundImage,
    }))()`);
    const heroPack = packs.find((p) => p.id === HERO_PACK);
    expectEqual(hero.name, heroPack.ja, "ヒーロー: 日本語名が出る");
    expectEqual(hero.num, "#009", "ヒーロー: 図鑑番号が3桁ゼロ埋めで出る");
    expectTrue(hero.typeChips.length > 0, "ヒーロー: タイプチップが1つ以上出る");
    expectTrue(
      hero.typeChips.every((c) => c.bg && c.bg !== "rgba(0, 0, 0, 0)"),
      `ヒーロー: タイプチップに色が付く (${JSON.stringify(hero.typeChips)})`,
    );
    expectTrue(
      /app:\/\/bundle\/assets\/raw\//.test(hero.spriteImage),
      `ヒーロー: スプライトが app:// から読み込まれる (${hero.spriteImage})`,
    );
    record(`ヒーロー表示 ${hero.name} ${hero.num} / タイプ${hero.typeChips.length}件`);
  }

  if (shotsDir) {
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(path.join(shotsDir, "01-aibou.png"), (await win.capturePage()).toPNG());
  }

  // ── 4. タブ切替（クリックで実際に切り替わるか） ─────────────
  {
    await click(`#tabs .tab[data-tab="box"]`);
    const state = await evalPage(`(() => ({
      aibouHidden: document.getElementById("panel-aibou").hidden,
      boxHidden: document.getElementById("panel-box").hidden,
      selected: [...document.querySelectorAll("#tabs .tab")].filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.dataset.tab),
      activeClass: [...document.querySelectorAll("#tabs .tab.active")].map((b) => b.dataset.tab),
    }))()`);
    expectEqual(state.boxHidden, false, "タブ切替: ボックスパネルが可視になる");
    expectEqual(state.aibouHidden, true, "タブ切替: あいぼうパネルが隠れる");
    expectEqual(state.selected.join(","), "box", "タブ切替: aria-selected が移動する");
    expectEqual(state.activeClass.join(","), "box", "タブ切替: active クラスが移動する");
    record("タブ切替 あいぼう→ボックス");
  }

  // ── 5. 検索（カナ / ひらがな / 図鑑番号） ────────────────────
  {
    await setSearch("ピカチュウ");
    const kana = await evalPage(`[...document.querySelectorAll("#grid .tile:not(.hidden)")].map((t) => t.dataset.id)`);
    expectTrue(kana.length > 0, "検索: カナ「ピカチュウ」で結果が出る");
    expectTrue(kana.every((id) => /pikachu/.test(id)), `検索: カナ結果がピカチュウのみ (${JSON.stringify(kana)})`);

    await setSearch("ぴかちゅう");
    const hira = await evalPage(`[...document.querySelectorAll("#grid .tile:not(.hidden)")].map((t) => t.dataset.id)`);
    expectTrue(
      hira.some((id) => /pikachu/.test(id)),
      `検索: ひらがな「ぴかちゅう」でもピカチュウが出る (${JSON.stringify(hira)})`,
    );

    await setSearch("025");
    const byNum = await evalPage(`[...document.querySelectorAll("#grid .tile:not(.hidden)")].map((t) => t.dataset.id)`);
    expectTrue(
      byNum.some((id) => /pikachu/.test(id)),
      `検索: 図鑑番号「025」でピカチュウが出る (${JSON.stringify(byNum)})`,
    );

    await setSearch("");
    expectEqual(await visibleCount(), normalCount, "検索: 空文字で全件に戻る");
    record("検索 カナ/ひらがな/図鑑番号");
  }

  if (shotsDir) {
    fs.writeFileSync(path.join(shotsDir, "02-box.png"), (await win.capturePage()).toPNG());
  }

  // ── 6. 世代フィルタ ─────────────────────────────────────────
  {
    await click(`#genChips .gen-chip[data-gen="2"]`);
    const gen2 = await evalPage(`(() => {
      const visible = [...document.querySelectorAll("#grid .tile:not(.hidden)")];
      return {
        count: visible.length,
        offGen: visible.filter((t) => t.dataset.gen !== "2").map((t) => t.dataset.id),
        activeChips: [...document.querySelectorAll("#genChips .gen-chip.active")].map((c) => c.dataset.gen),
      };
    })()`);
    expectTrue(gen2.count > 0, "世代フィルタ: 第2世代で結果が出る");
    expectEqual(gen2.offGen.length, 0, `世代フィルタ: 第2世代以外が混ざらない (${JSON.stringify(gen2.offGen.slice(0, 5))})`);
    expectEqual(gen2.activeChips.join(","), "2", "世代フィルタ: active チップが1つだけ");

    await click(`#genChips .gen-chip[data-gen="all"]`);
    expectEqual(await visibleCount(), normalCount, "世代フィルタ: 「全」で戻る");
    record(`世代フィルタ 第2世代 ${gen2.count}件`);
  }

  // ── 7. タイプフィルタ ───────────────────────────────────────
  {
    await click(`#typeChips .type-chip-filter[data-type="fire"]`);
    const fire = await evalPage(`(() => {
      const visible = [...document.querySelectorAll("#grid .tile:not(.hidden)")];
      const chip = document.querySelector('#typeChips .type-chip-filter[data-type="fire"]');
      return {
        count: visible.length,
        offType: visible.filter((t) => !(t.dataset.types || "").split(",").includes("fire")).map((t) => t.dataset.id),
        chipActive: chip.classList.contains("active"),
        chipBg: chip.style.backgroundColor,
      };
    })()`);
    expectTrue(fire.count > 0, "タイプフィルタ: ほのおで結果が出る");
    expectEqual(fire.offType.length, 0, `タイプフィルタ: ほのお以外が混ざらない (${JSON.stringify(fire.offType.slice(0, 5))})`);
    expectTrue(fire.chipActive, "タイプフィルタ: チップが active になる");
    expectTrue(!!fire.chipBg, "タイプフィルタ: active チップに背景色が付く");

    await click(`#typeChips .type-chip-filter[data-type="all"]`);
    expectEqual(await visibleCount(), normalCount, "タイプフィルタ: 「全」で戻る");
    record(`タイプフィルタ ほのお ${fire.count}件`);
  }

  // ── 8. 通常 ⇄ 地方フォルム切替でチップ群が入れ替わる ────────
  {
    await evalPage(`(() => {
      const el = document.getElementById("kind");
      el.value = "forms";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const forms = await evalPage(`(() => {
      const visible = [...document.querySelectorAll("#grid .tile:not(.hidden)")];
      return {
        count: visible.length,
        nonForm: visible.filter((t) => !t.dataset.region).length,
        chipsLabel: document.getElementById("genChips").getAttribute("aria-label"),
        regionChips: [...document.querySelectorAll("#genChips .gen-chip")].map((c) => c.dataset.region),
      };
    })()`);
    expectEqual(forms.count, formCount, "フォルム切替: 地方フォルムのみ可視");
    expectEqual(forms.nonForm, 0, "フォルム切替: 通常パックが混ざらない");
    expectEqual(forms.chipsLabel, "地方フィルタ", "フォルム切替: チップ群が地方フィルタへ入れ替わる");
    expectTrue(forms.regionChips.includes("all"), "フォルム切替: 地方チップに「全」がある");
    expectTrue(forms.regionChips.filter(Boolean).length > 1, "フォルム切替: 地方チップが生成される");

    await evalPage(`(() => {
      const el = document.getElementById("kind");
      el.value = "normal";
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expectEqual(await visibleCount(), normalCount, "フォルム切替: 通常へ戻る");
    record(`地方フォルム切替 ${forms.count}件 / 地方チップ${forms.regionChips.filter(Boolean).length}件`);
  }

  // ── 9. スライダー換算（UI 0.5-10.0 ⇄ 内部 lerp 0.05-1.0） ───
  {
    await click(`#tabs .tab[data-tab="aibou"]`);

    const lerpMax = await commitNumber("lerp", "10.0");
    expectEqual(lerpMax.lerp, 1, "速さ: UI 10.0 → 内部 lerp 1.0");
    const lerpMin = await commitNumber("lerp", "0.5");
    expectEqual(lerpMin.lerp, 0.05, "速さ: UI 0.5 → 内部 lerp 0.05");
    const lerpOver = await commitNumber("lerp", "99");
    expectEqual(lerpOver.lerp, 1, "速さ: 上限超過は max(10.0) にクランプされてから換算");
    const lerpReadout = await evalPage(`({ value: document.getElementById("lerp").value, readout: document.getElementById("lerpVal").textContent })`);
    expectEqual(lerpReadout.value, "10.0", "速さ: クランプ後の入力値が正規化表示になる");
    expectEqual(lerpReadout.readout, "10.0", "速さ: 読み上げ表示が正規化される");

    const scale = await commitNumber("scale", "2.5");
    expectEqual(scale.scale, 2.5, "大きさ: 入力値がそのまま patch に載る");
    const scaleOver = await commitNumber("scale", "999");
    expectEqual(scaleOver.scale, 10, "大きさ: 上限 10.0 にクランプされる");

    const offset = await commitNumber("offset", "120");
    expectEqual(offset.offset, 120, "距離: 入力値がそのまま patch に載る");
    const offsetNeg = await commitNumber("offset", "-5");
    expectEqual(offsetNeg.offset, 0, "距離: 下限 0 にクランプされる");
    const offsetFrac = await commitNumber("offset", "70.6");
    expectEqual(offsetFrac.offset, 71, "距離: 小数は整数へ丸められる");
    record("スライダー換算 lerp/scale/offset とクランプ");
  }

  if (shotsDir) {
    fs.writeFileSync(path.join(shotsDir, "03-aibou-slider.png"), (await win.capturePage()).toPNG());
  }

  // ── 10. せっていタブのトグルがストア形キーで送られる ────────
  {
    await click(`#tabs .tab[data-tab="settings"]`);
    const before = patches.length;
    await click(`#enabled`);
    await click(`#avoidCursor`);
    await click(`#appReactions`);
    await click(`#notificationCompanion`);
    const emitted = patches.slice(before);
    const keys = emitted.flatMap((p) => Object.keys(p));
    expectEqual(emitted.length, 4, `せってい: トグル4件で patch 4件 (${JSON.stringify(emitted)})`);
    for (const key of ["enabled", "avoidCursor", "appReactionsEnabled", "notificationCompanionEnabled"]) {
      expectTrue(keys.includes(key), `せってい: patch がストア形キー ${key} に正規化される (got ${JSON.stringify(keys)})`);
    }
    expectTrue(
      !keys.some((k) => k.startsWith("vcp1_")),
      `せってい: vcp1_ 接頭辞が main へ漏れない (got ${JSON.stringify(keys)})`,
    );
    expectEqual(emitted.find((p) => "enabled" in p).enabled, false, "せってい: 有効トグルOFFが反映される");
    record("せっていトグル4件のキー正規化");
  }

  // ── 11. バージョン表示 / 更新確認ボタン ─────────────────────
  {
    await waitFor(`document.getElementById("appVersion").textContent.trim() === "v1.4.0"`, "app version to render");
    record("バージョン表示 v1.4.0");
  }

  if (shotsDir) {
    fs.writeFileSync(path.join(shotsDir, "04-settings.png"), (await win.capturePage()).toPNG());
  }

  // ── 12. 空きスロットをタップするとボックスタブへ飛ぶ ────────
  {
    await click(`#tabs .tab[data-tab="aibou"]`);
    await click(`#partyRowAibou .party-slot.empty`);
    const state = await evalPage(`({ boxHidden: document.getElementById("panel-box").hidden })`);
    expectEqual(state.boxHidden, false, "空きスロット: タップでボックスタブへ遷移する");
    record("空きスロット→ボックス遷移");
  }

  // ── 13. 読み込み中に renderer エラーが出ていない ────────────
  expectEqual(consoleErrors.length, 0, `renderer console error: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
  record("renderer コンソールエラー 0件");

  console.log(`[verify-settings-ui-render] ok: ${checks.length} checks`);
  for (const name of checks) console.log(`  - ${name}`);
  if (shotsDir) console.log(`[verify-settings-ui-render] screenshots=${shotsDir} (scale=${shotScale})`);
  app.quit();
}

// ─── エントリ ─────────────────────────────────────────────────────
if (process.versions.electron && process.type === "browser") {
  const { app } = require("electron");
  runElectronMain().catch((error) => {
    console.error(`[verify-settings-ui-render] ${error.stack || error.message}`);
    process.exitCode = 1;
    app.quit();
  });
} else {
  const electron = require("electron");
  const result = spawnSync(electron, [__filename], {
    cwd: root,
    env: { ...process.env },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
