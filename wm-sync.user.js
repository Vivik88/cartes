// ==UserScript==
// @name         Wiki Masters → ma collection sur GitHub
// @namespace    vivik88.cartes
// @version      1.7
// @description  Une fois par jour, relit ma collection Wiki Masters et met à jour owned.json dans mon dépôt GitHub.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  /* ---------- Réglages ---------- */
  var HEURE = 20;            // pas de synchronisation automatique avant cette heure (0 à 23)
  var PAUSE_MS = 700;        // pause entre deux pages demandées au site
  var JOURS_COMPLET = 7;     // relecture complète au plus tous les N jours (détecte les cartes vendues ou échangées)
  var FICHIER = "owned.json";

  var cfg = GM_getValue("cfg", { owner: "vivik88", repo: "cartes", token: "" });
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------- Petit message en bas à droite ---------- */
  var box = null;
  function say(text, keep) {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText = "position:fixed;left:10px;right:10px;top:10px;z-index:2147483647;margin:0 auto;max-width:420px;text-align:center;padding:12px 14px;border-radius:10px;background:#15171c;color:#eceef2;font:14px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);border:1px solid #2e313a";
      (document.body || document.documentElement).appendChild(box);
    }
    if (!box.isConnected) (document.body || document.documentElement).appendChild(box);
    box.textContent = "Collection → GitHub : " + text;
    try { console.log("[wm-sync] " + text); } catch (e) {}
    box.hidden = false;
    clearTimeout(say.t);
    if (!keep) say.t = setTimeout(function () { box.hidden = true; }, 8000);
  }

  /* ---------- Lecture de la collection sur Wiki Masters ---------- */
  async function page(sort, n) {
    var r = await fetch("/api/my-collection?sort=" + sort + "&page=" + n + "&stats=0", { credentials: "include" });
    if (!r.ok) { var e = new Error("le site a répondu " + r.status); e.status = r.status; throw e; }
    var rows = (await r.json()).collection || [];
    return rows.filter(function (x) { return x && x.id && x.card && x.card.wikipedia_title; })
      .map(function (x) { return { id: String(x.id), t: x.card.wikipedia_title, r: x.card.rarity || "C", n: Math.max(1, Number(x.count) || 1), o: Date.parse(x.obtained_at || "") || 0 }; });
  }

  /* Tri « obtenues récemment » : c'est « added » sur Wiki Masters. Par sécurité, on vérifie qu'il renvoie bien les cartes de la plus
     récente à la plus ancienne ; sinon on essaie d'autres noms plausibles. Le résultat est mémorisé. */
  var CANDIDATS = ["added", "recent", "newest", "latest", "obtained_at", "-obtained_at", "obtained", "date", "date_desc", "new", "created_at", "-created_at"];
  function desc(rows) { var ok = rows.filter(function (x) { return x.o; }); if (ok.length < 10) return false;
    for (var i = 1; i < ok.length; i++) if (ok[i].o > ok[i - 1].o) return false; return ok[0].o > ok[ok.length - 1].o; }
  async function recentSort() {
    var known = GM_getValue("sortRecent", null);
    if (known) return known;
    /* Un nom de tri inconnu est ignoré par le site, qui renvoie alors l'ordre par rareté : on écarte tout ce qui ressemble à cet ordre. */
    var base = (await page("rarity", 0)).map(function (x) { return x.id; }).join(","); await sleep(PAUSE_MS);
    for (var i = 0; i < CANDIDATS.length; i++) {
      var rows = await page(CANDIDATS[i], 0);
      if (desc(rows) && rows.map(function (x) { return x.id; }).join(",") !== base) { GM_setValue("sortRecent", CANDIDATS[i]); return CANDIDATS[i]; }
      await sleep(PAUSE_MS);
    }
    throw new Error("je ne trouve pas le tri par date d'obtention du site");
  }
  async function total() {
    try { var r = await fetch("/api/my-collection/stats?sort=rarity", { credentials: "include" }); if (!r.ok) return null; return Number((await r.json()).total) || null; }
    catch (e) { return null; }
  }

  /* Relecture complète : toutes les pages. */
  /* Relecture complète : toutes les pages, des plus récentes aux plus anciennes (ordre stable, donc aucune carte sautée entre deux pages).
     L'avancement est mémorisé toutes les 10 pages : si l'onglet est fermé ou mis en veille, la lecture reprend où elle s'était arrêtée. */
  async function readAll() {
    var part0 = GM_getValue("partial", null), rows = {}, start = 0;
    if (part0 && part0.rows && Date.now() - part0.t < 2 * 3600e3) { rows = part0.rows; start = Math.max(0, part0.next - 1); }
    for (var n = start; n < 600; n++) {
      var part = await page(await recentSort(), n);
      if (!part.length) break;
      part.forEach(function (x) { rows[x.id] = x; });
      say("lecture complète, " + Object.keys(rows).length + " cartes…", true);
      if (n % 10 === 9) GM_setValue("partial", { rows: rows, next: n + 1, t: Date.now() });
      await sleep(PAUSE_MS);
    }
    if (!Object.keys(rows).length) throw new Error("aucune carte lue (êtes-vous connecté ?)");
    GM_setValue("partial", null);
    return rows;
  }

  /* Relecture rapide : les plus récentes d'abord. On compare les exemplaires par leur identifiant propre, pas par leur titre,
     donc un doublon d'une carte déjà possédée est bien vu comme nouveau. On s'arrête après une page entière déjà connue. */
  async function readRecent(rows) {
    var added = 0;
    for (var n = 0; n < 600; n++) {
      var part = await page(await recentSort(), n);
      if (!part.length) break;
      var fresh = 0;
      part.forEach(function (x) { if (!rows[x.id]) { fresh++; added++; } rows[x.id] = x; });
      say("nouvelles cartes : " + added + "…", true);
      if (!fresh) break;
      await sleep(PAUSE_MS);
    }
    return added;
  }

  /* ---------- Écriture sur GitHub ---------- */
  function gh(method, body) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: "https://api.github.com/repos/" + encodeURIComponent(cfg.owner) + "/" + encodeURIComponent(cfg.repo) + "/contents/" + FICHIER + (method === "GET" ? "?t=" + Date.now() : ""),
        headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + cfg.token, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        data: body ? JSON.stringify(body) : undefined,
        onload: function (res) {
          var j = null; try { j = JSON.parse(res.responseText); } catch (e) {}
          if (res.status >= 200 && res.status < 300) resolve(j);
          else { var er = new Error(res.status === 401 ? "clé GitHub refusée" : res.status === 404 ? "dépôt ou fichier introuvable" : "GitHub a répondu " + res.status); er.status = res.status; reject(er); }
        },
        onerror: function () { reject(new Error("GitHub injoignable")); }
      });
    });
  }
  function b64(s) { var b = new TextEncoder().encode(s), bin = ""; for (var i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); }
  function buildOwned(rows) {
    var seen = {}, out = { C: [], PC: [], R: [], SR: [], UR: [], L: [] }, n = 0;
    Object.keys(rows).forEach(function (id) { var x = rows[id]; if (seen[x.t]) return; seen[x.t] = 1; (out[x.r] = out[x.r] || []).push(x.t); n++; });
    Object.keys(out).forEach(function (r) { out[r].sort(); });
    return JSON.stringify({ n: n, d: new Date().toISOString(), r: out });
  }
  async function publish(rows) {
    var text = buildOwned(rows);
    var same = text.replace(/"d":"[^"]*",/, "") === String(GM_getValue("lastText", "")).replace(/"d":"[^"]*",/, "");
    var sha; try { sha = (await gh("GET")).sha; } catch (e) { if (e.status !== 404) throw e; }
    await gh("PUT", { message: "Mise à jour de la collection", content: b64(text), sha: sha });
    GM_setValue("lastText", text);
    return !same;
  }

  /* ---------- Vérification des N dernières cartes, lancée depuis le site ----------
     On lit les N cartes les plus récentes et on les ajoute au relevé publié (sans rien retirer), quel que soit l'appareil. */
  function b64dec(s) { var bin = atob(String(s || "").replace(/\s/g, "")), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new TextDecoder().decode(b); }
  async function checkRecent(n) {
    if (running) return null; running = true;
    try {
      if (!cfg.token) { say("pas encore configuré.", true); configure(); return null; }
      say("vérification des " + n + " dernières cartes…", true);
      var recent = [];
      for (var p = 0; p * 50 < n; p++) {
        var part = await page(await recentSort(), p); if (!part.length) break;
        recent = recent.concat(part); await sleep(PAUSE_MS);
      }
      recent = recent.slice(0, n);
      if (!desc(recent.slice(0, 50))) { GM_setValue("sortRecent", null); throw new Error("le tri par date ne répond plus correctement, relancez"); }
      var file = null, sha;
      try { var g = await gh("GET"); sha = g.sha; file = JSON.parse(b64dec(g.content)); } catch (e) { if (e.status !== 404) throw e; }
      if (!file || !file.r) file = { n: 0, r: {} };
      var where = {};
      Object.keys(file.r).forEach(function (r) { file.r[r].forEach(function (t) { where[t] = r; }); });
      var added = 0, moved = 0;
      recent.forEach(function (x) {
        var was = where[x.t];
        if (was === x.r) return;
        if (was) { file.r[was] = file.r[was].filter(function (t) { return t !== x.t; }); moved++; } else added++;
        (file.r[x.r] = file.r[x.r] || []).push(x.t); where[x.t] = x.r;
      });
      var rows = GM_getValue("rows", null);
      if (rows) { recent.forEach(function (x) { rows[x.id] = x; }); GM_setValue("rows", rows); }
      if (added || moved) {
        Object.keys(file.r).forEach(function (r) { file.r[r].sort(); });
        file.n = Object.keys(where).length; file.d = new Date().toISOString();
        await gh("PUT", { message: "Vérification des " + n + " dernières cartes", content: b64(JSON.stringify(file)), sha: sha });
      }
      say(recent.length + " cartes vérifiées : " + added + " ajoutée" + (added > 1 ? "s" : "") + " au relevé" + (moved ? ", " + moved + " rareté" + (moved > 1 ? "s" : "") + " corrigée" + (moved > 1 ? "s" : "") : "") + ".");
      return { cards: recent.map(function (x) { return { t: x.t, r: x.r }; }), added: added, moved: moved, d: file.d || "" };
    } catch (e) {
      say("vérification impossible (" + (e.message || e) + ").");
      return { error: String(e.message || e) };
    } finally { running = false; }
  }

  /* ---------- Synchronisation ---------- */
  var running = false;
  async function sync(full) {
    if (running) return; running = true;
    try {
      say("démarrage…", true);
      if (!cfg.token) { say("pas encore configuré.", true); configure(); return; }
      var rows = GM_getValue("rows", null), lastFull = GM_getValue("lastFull", 0), added = null;
      if (!rows || full || GM_getValue("partial", null) || Date.now() - lastFull > JOURS_COMPLET * 864e5) {
        rows = await readAll(); GM_setValue("lastFull", Date.now());
      } else {
        added = await readRecent(rows);
      }
      GM_setValue("rows", rows); GM_setValue("lastSync", Date.now());
      var sent = await publish(rows), nb = Object.keys(rows).length;
      say((added === null ? nb + " cartes relues" : added + " nouvelle" + (added > 1 ? "s" : "") + " carte" + (added > 1 ? "s" : "")) + (sent ? ", fichier mis à jour." : ", rien à changer."));
    } catch (e) {
      say("échec (" + (e.message || e) + "). Nouvel essai à la prochaine visite.");
    } finally { running = false; }
  }

  function due() {
    var last = GM_getValue("lastSync", 0), now = new Date(), seuil = new Date(now); seuil.setHours(HEURE, 0, 0, 0);
    if (Date.now() - last > 36 * 3600e3) return true;          // plus d'un jour et demi sans synchronisation
    return now >= seuil && last < seuil.getTime();              // l'heure est passée et rien n'a été fait depuis
  }

  GM_registerMenuCommand("Synchroniser maintenant", function () { sync(false); });
  GM_registerMenuCommand("Relecture complète", function () { sync(true); });
  /* Formulaire de configuration affiché dans la page (plus fiable sur téléphone que les fenêtres de saisie du navigateur). */
  function configure() {
    var old = document.getElementById("wm-sync-cfg"); if (old) old.remove();
    var wrap = document.createElement("div"); wrap.id = "wm-sync-cfg";
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px";
    var f = document.createElement("form");
    f.style.cssText = "width:100%;max-width:420px;background:#15171c;color:#eceef2;border:1px solid #2e313a;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px;font:15px/1.35 system-ui,sans-serif";
    var title = document.createElement("strong"); title.textContent = "Collection → GitHub : configuration"; f.appendChild(title);
    function field(label, value, type) {
      var l = document.createElement("label"); l.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:13px;color:#9aa0ad"; l.appendChild(document.createTextNode(label));
      var i = document.createElement("input"); i.type = type || "text"; i.value = value; i.autocapitalize = "off"; i.autocomplete = "off"; i.spellcheck = false;
      i.style.cssText = "font:16px system-ui,sans-serif;padding:10px;border-radius:8px;border:1px solid #2e313a;background:#0e0f12;color:#eceef2;width:100%;box-sizing:border-box";
      l.appendChild(i); f.appendChild(l); return i;
    }
    var o = field("Compte GitHub", cfg.owner), r = field("Dépôt", cfg.repo);
    var t = field(cfg.token ? "Clé d'accès GitHub (laissez vide pour garder l'actuelle)" : "Clé d'accès GitHub (commence par github_pat_)", "", "text");
    var msg = document.createElement("div"); msg.style.cssText = "font-size:13px;color:#ffb224;min-height:1.2em"; f.appendChild(msg);
    var row = document.createElement("div"); row.style.cssText = "display:flex;gap:10px"; f.appendChild(row);
    function button(text, primary) { var b = document.createElement("button"); b.textContent = text; b.type = primary ? "submit" : "button";
      b.style.cssText = "flex:1;font:600 15px system-ui,sans-serif;padding:11px;border-radius:8px;border:1px solid " + (primary ? "#ffb224;background:#ffb224;color:#1d1400" : "#2e313a;background:transparent;color:#eceef2"); row.appendChild(b); return b; }
    button("Fermer").onclick = function () { wrap.remove(); };
    button("Enregistrer", true);
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var tok = t.value.trim() || cfg.token;
      if (!o.value.trim() || !r.value.trim() || !tok) { msg.textContent = "Renseignez le compte, le dépôt et la clé."; return; }
      cfg = { owner: o.value.trim(), repo: r.value.trim(), token: tok }; GM_setValue("cfg", cfg);
      msg.textContent = "Vérification de la clé…";
      gh("GET").then(function () { wrap.remove(); say("configuration enregistrée, la clé fonctionne. Lancement de la synchronisation."); sync(false); },
        function (e) { if (e.status === 404 && /fichier/.test(e.message)) { /* dépôt accessible mais fichier absent : acceptable */ }
          msg.textContent = "Enregistré, mais GitHub répond : " + e.message + ". Vérifiez le compte, le dépôt et la clé."; });
    };
    wrap.appendChild(f); (document.body || document.documentElement).appendChild(wrap); t.focus();
  }
  GM_registerMenuCommand("Configurer", configure);

  var asked = location.hash.match(/^#wm-check-(\d{1,4})$/);
  if (asked) {
    var n = Math.min(1000, Math.max(1, Number(asked[1])));
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(async function () {
      var res = await checkRecent(n);
      if (res && window.opener) {
        try { window.opener.postMessage(Object.assign({ wmCheck: true }, res), "*"); } catch (e) {}
        if (!res.error) { say((res.added || 0) + " ajoutée(s) au relevé. Retour sur votre site…"); setTimeout(function () { window.close(); }, 2500); }
      }
    }, 1500);
  } else if (due()) setTimeout(function () { sync(false); }, 6000);
})();
