// ==UserScript==
// @name         Wiki Masters → ma collection sur GitHub
// @namespace    vivik88.cartes
// @version      1.2
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
      .map(function (x) { return { id: String(x.id), t: x.card.wikipedia_title, r: x.card.rarity || "C", n: Math.max(1, Number(x.count) || 1) }; });
  }
  async function total() {
    try { var r = await fetch("/api/my-collection/stats?sort=rarity", { credentials: "include" }); if (!r.ok) return null; return Number((await r.json()).total) || null; }
    catch (e) { return null; }
  }

  /* Relecture complète : toutes les pages. */
  async function readAll() {
    var rows = {}, count = 0;
    for (var n = 0; n < 600; n++) {
      var part = await page("rarity", n);
      if (!part.length) break;
      part.forEach(function (x) { rows[x.id] = x; }); count += part.length;
      say("lecture complète, " + count + " cartes…", true);
      await sleep(PAUSE_MS);
    }
    if (!count) throw new Error("aucune carte lue (êtes-vous connecté ?)");
    return rows;
  }

  /* Relecture rapide : les plus récentes d'abord. On compare les exemplaires par leur identifiant propre, pas par leur titre,
     donc un doublon d'une carte déjà possédée est bien vu comme nouveau. On s'arrête après une page entière déjà connue. */
  async function readRecent(rows) {
    var added = 0;
    for (var n = 0; n < 600; n++) {
      var part = await page("recent", n);
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
    return JSON.stringify({ n: n, d: new Date().toISOString().slice(0, 10), r: out });
  }
  async function publish(rows) {
    var text = buildOwned(rows);
    if (text.replace(/"d":"[^"]*",/, "") === String(GM_getValue("lastText", "")).replace(/"d":"[^"]*",/, "")) return false;
    var sha; try { sha = (await gh("GET")).sha; } catch (e) { if (e.status !== 404) throw e; }
    await gh("PUT", { message: "Mise à jour de la collection", content: b64(text), sha: sha });
    GM_setValue("lastText", text);
    return true;
  }

  /* ---------- Synchronisation ---------- */
  var running = false;
  async function sync(full) {
    if (running) return; running = true;
    try {
      say("démarrage…", true);
      if (!cfg.token) { say("pas encore configuré.", true); configure(); return; }
      var rows = GM_getValue("rows", null), lastFull = GM_getValue("lastFull", 0), added = null;
      if (!rows || full || Date.now() - lastFull > JOURS_COMPLET * 864e5) {
        rows = await readAll(); GM_setValue("lastFull", Date.now());
      } else {
        added = await readRecent(rows);
        var tot = await total(), have = Object.keys(rows).length, copies = 0;
        Object.keys(rows).forEach(function (id) { copies += rows[id].n; });
        if (tot && tot > have && tot > copies) { rows = await readAll(); GM_setValue("lastFull", Date.now()); added = null; }
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

  if (due()) setTimeout(function () { sync(false); }, 6000);
})();
