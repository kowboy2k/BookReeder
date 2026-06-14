"use strict";

// --- État global ---
const etat = {
  mots: [],          // liste des mots du livre
  chapitres: [],     // [{ titre, debut }] debut = index du mot de départ
  idLivre: null,     // identifiant du livre courant (clé bibliothèque)
  nomLivre: "",      // nom de fichier affiché
  index: 0,          // position de lecture actuelle
  enLecture: false,
  minuteur: null,
  vitesse: 300,      // mots/min (vitesse par défaut)
  nbMots: 1,         // mots affichés simultanément (max souhaité)
  modeStrict: false, // « 1 (strict) » : 1 mot, sans groupage des noms propres
  nbCourant: 1,      // mots réellement affichés dans le chunk courant
  continuerApresSaut: true, // garder la lecture en marche après avance/retour
  pauseAuto: "fin",         // pause auto : "fin" (fin de chapitre), "suivant" (ouverture du suivant), "off"
  _pauseApresChunk: false,  // drapeau interne pour le mode "suivant"
  coefPause: 2,      // coefficient multiplicateur des temps de pause (0,5–4)
  coefDialogue: 1.3, // ralentissement des pauses en dialogue (×1 à ×2)
  coefAccel: 1,      // accélération max visée (×1 = constante, jusqu'à ×3)
  multAccel: 1,      // multiplicateur d'accélération courant (1 → coefAccel)
  intervalleAccel: 10, // secondes entre deux hausses de +0,1×
  elan: 1,           // « momentum » : <1 juste après une pause, remonte vers 1
  coefElan: 1,       // élan à la reprise : 0 = aucun, ×1 ≈ 10 mots, ×3 ≈ 30 mots
  orpActif: true,
  bionic: false,     // lecture bionic (début des mots en gras)
  dialoguesEffets: [], // effets dialogues actifs : "elocution" "multicolore" "italique" "fondu"
  couleurParMot: null, // Map index mot -> couleur (multicolore, calculée au chargement)
  modeleId: "default", // modèle de lecture actif (groupement + rythme + ORP + bionic)
  modele: null,        // objet modèle courant (défini au démarrage)
  // « Afficher les signes de dialogues » (cadratins — et guillemets « » " " qui
  // entourent les répliques). À FALSE (défaut) : MASQUÉS quand l'effet « Couleurs »
  // est actif (la couleur suffit alors à marquer le locuteur) ; s'applique en
  // lecture rapide + minimaliste (vertical/horizontal), JAMAIS en Mode Loupe.
  // Mettre à TRUE pour toujours afficher les signes. C'est un réglage de code.
  afficherSignesDlg: false,
};
// Retire les signes de dialogue (cadratin de réplique en tête + guillemets) d'un
// chunk pour l'AFFICHAGE seulement (les mots d'origine, navigation et durée, ne
// changent pas). N'enlève jamais une apostrophe (l'argile).
function masquerSignesDlg(t) {
  const out = t
    .replace(/^[\s ]*[—–―‒][\s ]*/u, "")            // cadratin de réplique en tête
    .replace(/[\s ]*[«»“”‹›"″][\s ]*/gu, " ")       // guillemets (n'importe où)
    .replace(/\s{2,}/g, " ")
    .trim();
  return out || t;   // garde-fou : ne jamais renvoyer un chunk vide
}
// Un effet de dialogue est-il actif ?
function effetDialogue(nom) { return (etat.dialoguesEffets || []).indexOf(nom) >= 0; }

// --- Moteur des dialogues, chargé à la demande (dialogues.js) ---
// Nécessaire seulement pour Multicolore (couleurs) et Élocution (rythme).
function besoinMoteurDialogues() { return effetDialogue("multicolore") || effetDialogue("elocution"); }
let _dlgEnCours = false;
function chargerMoteurDialogues(apres) {
  if (window.MoteurDialogues) { if (apres) apres(); return; }
  if (_dlgEnCours) return;
  _dlgEnCours = true;
  const sc = document.querySelector('script[src*="app.js"]');
  const m = sc && sc.src.match(/[?&]v=(\d+)/);
  const s = document.createElement("script");
  s.src = "dialogues.js" + (m ? "?v=" + m[1] : "");
  s.onload = () => { _dlgEnCours = false; if (apres) apres(); };
  s.onerror = () => { _dlgEnCours = false; };
  document.head.appendChild(s);
}
// Recalcule la carte des couleurs (multicolore) si besoin ; charge le moteur au besoin.
function recalcLocuteurs() {
  if (!effetDialogue("multicolore")) return;
  const fini = () => {
    if (window.MoteurDialogues) window.MoteurDialogues.calculerLocuteurs();
    if (!ecranLecture.classList.contains("cache")) afficherChunk();
  };
  if (window.MoteurDialogues) fini(); else chargerMoteurDialogues(fini);
}

// Un mot qui termine une phrase : ponctuation forte éventuellement suivie
// d'un guillemet/parenthèse fermant. On ne regroupe jamais après lui.
const FIN_PHRASE = /[.!?…]["»”'’)\]]*$/;

// Délai avant que la lecture ne reprenne après un saut (phrase/chapitre),
// réinitialisé à chaque clic : laisse le temps d'enchaîner les appuis.
const DELAI_REPRISE = 800;

// --- Références DOM ---
const $ = (id) => document.getElementById(id);
const ecranAccueil = $("ecran-accueil");
const ecranLecture = $("ecran-lecture");
const motAffiche = $("mot-affiche");
const zoneMot = $("zone-mot");

// Date au format français JJ/MM/AAAA HH:MM:SS
function formatDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// =========================================================
//  Bibliothèque persistante (IndexedDB)
//  On stocke le texte déjà découpé + les chapitres pour
//  reprendre instantanément sans relire l'EPUB.
// =========================================================
// Demande au navigateur de NE PAS supprimer le stockage (livres + positions)
// même quand le cache de l'app change à chaque mise à jour. Évite que la
// bibliothèque « disparaisse » (éviction iOS/Android sous pression de stockage).
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then((dejaPersistant) => {
    if (!dejaPersistant) navigator.storage.persist().catch(() => {});
  }).catch(() => {});
}

let baseDonnees = null;
function ouvrirBase() {
  if (baseDonnees) return Promise.resolve(baseDonnees);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("bookreeder", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("livres"))
        db.createObjectStore("livres", { keyPath: "id" });
    };
    req.onsuccess = () => { baseDonnees = req.result; resolve(baseDonnees); };
    req.onerror = () => reject(req.error);
  });
}

async function transaction(mode, action) {
  const db = await ouvrirBase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("livres", mode);
    const store = tx.objectStore("livres");
    const req = action(store);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

const sauverLivre = (livre) => transaction("readwrite", (s) => s.put(livre));
const listerLivres = () => transaction("readonly", (s) => s.getAll());
const lireLivre = (id) => transaction("readonly", (s) => s.get(id));
const supprimerLivre = (id) => transaction("readwrite", (s) => s.delete(id));

// Enregistre la position de lecture actuelle dans la bibliothèque
async function sauverPosition() {
  if (!etat.idLivre) return;
  const livre = await lireLivre(etat.idLivre);
  if (livre) {
    // Position stockée en fraction (0–1) : indépendante de la tokenisation du modèle
    livre.progression = etat.mots.length ? etat.index / etat.mots.length : 0;
    livre.total = etat.mots.length;
    if (etat.profil) livre.profil = etat.profil;   // profil de lecture du livre (v2.95)
    if (etat.persos) livre.persos = etat.persos;   // personnages détectés (v2.96)
    await sauverLivre(livre);
  }
}

// =========================================================
//  Profil de lecture PAR LIVRE (v2.95)
// =========================================================
// Chaque livre mémorise ses propres réglages dans sa fiche (IndexedDB, champ
// `profil`). Tant qu'un réglage n'a pas été modifié pendant la lecture de CE
// livre, il suit la valeur globale (localStorage) ; dès qu'on le modifie, la
// valeur va dans le profil du livre (le global reste intact).
//
// Mise en œuvre : un « shim » sur localStorage intercepte les clés de réglage
// (bookreeder-*) quand un livre est ouvert → lecture/écriture dans etat.profil.
// Aucun des appels localStorage existants n'a besoin d'être modifié.
function estCleProfil(k) {
  return typeof k === "string" && k.indexOf("bookreeder-") === 0 &&
         k.indexOf("bookreeder-toc-") !== 0 && k !== "bookreeder-vue-version" &&
         k !== "bookreeder-tri-biblio" && k !== "bookreeder-meta-biblio";
}
(function installerShimProfil() {
  const proto = Storage.prototype;
  const _get = proto.getItem, _set = proto.setItem;
  proto.getItem = function (k) {
    try {
      if (estCleProfil(k) && typeof etat !== "undefined" && etat.idLivre && etat.profil &&
          Object.prototype.hasOwnProperty.call(etat.profil, k)) return etat.profil[k];
    } catch (e) {}
    return _get.call(this, k);
  };
  proto.setItem = function (k, v) {
    try {
      if (estCleProfil(k) && typeof etat !== "undefined" && etat.idLivre) {
        // Pendant l'APPLICATION des réglages (ouverture d'un livre), on n'écrit
        // rien : on applique seulement. Le profil ne se remplit que sur une
        // VRAIE modification de l'utilisateur (« profil vide → suit le global »).
        if (_appliquantReglages) return;
        if (!etat.profil) etat.profil = {};
        etat.profil[k] = String(v);
        planifierSauvegardeProfil();
        return;
      }
    } catch (e) {}
    return _set.call(this, k, v);
  };
})();
let _appliquantReglages = false;
let _timerProfil = null;
function planifierSauvegardeProfil() {
  clearTimeout(_timerProfil);
  _timerProfil = setTimeout(() => { sauverPosition(); }, 400);   // sauve position + profil
}
// (Ré)applique tous les réglages à l'UI/état depuis le stockage : profil du livre
// courant si présent (via le shim), sinon valeurs globales. Appelé à l'ouverture.
function rechargerReglages() {
  _appliquantReglages = true;
  try { _rechargerReglages(); } finally { _appliquantReglages = false; }
}
function _rechargerReglages() {
  const g = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const num = (k, d) => { const s = g(k); return (s != null && isFinite(+s)) ? +s : d; };
  const str = (k, d) => { const s = g(k); return s != null ? s : d; };
  try { activerModele(str("bookreeder-modele", "default")); const sm = $("reglage-modele"); if (sm) sm.value = etat.modeleId; } catch (e) {}
  try { appliquerTheme(str("bookreeder-theme", "midnight")); } catch (e) {}
  try { const cp = JSON.parse(g("bookreeder-perso-voix") || "null"); if (Array.isArray(cp) && cp.length === 3) couleursPerso = cp; } catch (e) {}
  try { appliquerPaletteDialogue(str("bookreeder-palette-dialogue", "Corail"), str("bookreeder-palette-theme", "")); } catch (e) {}
  try { initialiserOrpCouleur(); } catch (e) {}
  try { appliquerDialogues(str("bookreeder-dialogues", "aucun")); } catch (e) {}
  try { appliquerPauseAuto(str("bookreeder-pause-auto", "fin")); } catch (e) {}
  try { appliquerMarqueurNote(str("bookreeder-marqueur-note", "etoile")); } catch (e) {}
  try { if (typeof appliquerFacteursRythme === "function") appliquerFacteursRythme(); } catch (e) {}
  try { if (typeof appliquerLoupeTexte === "function") appliquerLoupeTexte(str("bookreeder-loupe-texte", "defaut")); } catch (e) {}
  try { appliquerCoefPause(num("bookreeder-coef-pause", 2)); } catch (e) {}
  try { appliquerCoefDialogue(num("bookreeder-coef-dialogue", 1.3)); } catch (e) {}
  try { appliquerCoefElan(num("bookreeder-coef-elan", 1)); } catch (e) {}
  try { appliquerCoefAccel(num("bookreeder-coef-accel", 1)); } catch (e) {}
  try { appliquerIntervalleAccel(num("bookreeder-accel-intervalle", 10)); } catch (e) {}
  try { appliquerTailleLoupe(num("bookreeder-taille-loupe", 100)); } catch (e) {}
  try { appliquerDimLoupe(num("bookreeder-dim-loupe", 50)); } catch (e) {}
  try { appliquerRalentiNom(str("bookreeder-ralenti-nom", "off")); } catch (e) {}
  try { reglerVitesse(num("bookreeder-vitesse", 300)); } catch (e) {}
  try { etat.couleursPersonnages = JSON.parse(g("bookreeder-perso-couleurs") || "{}") || {}; } catch (e) { etat.couleursPersonnages = {}; }
  try { etat.persosCuration = JSON.parse(g("bookreeder-persos-curation") || "{}") || {}; } catch (e) { etat.persosCuration = {}; }
  { const cn = $("reglage-cacher-noms"); if (cn) cn.checked = (g("bookreeder-cacher-noms") !== "0"); }
  { const ib = $("reglage-indice-bavardage"); if (ib) ib.value = g("bookreeder-indice-bavardage") || "masque"; }
  [["reglage-infos-minimal", "bookreeder-infos-minimal"], ["reglage-pause-loupe", "bookreeder-pause-loupe"]].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    el.checked = (g(key) === "1");
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  try { restaurerReglagesGeneriques(); } catch (e) {}
}

// =========================================================
//  Chargement du fichier EPUB
// =========================================================
$("input-fichier").addEventListener("change", async (e) => {
  const fichier = e.target.files[0];
  if (!fichier) return;
  const nom = (fichier.name || "").toLowerCase();
  const msg = $("message-chargement");
  try {
    if (nom.endsWith(".txt")) {
      await chargerTexteBrut(await fichier.text(), fichier.name, fichier.size);
    } else if (nom.endsWith(".pdf")) {
      await chargerPdf(await fichier.arrayBuffer(), fichier.name, fichier.size);
    } else {
      await chargerEpub(await fichier.arrayBuffer(), fichier.name, fichier.size);
    }
  } catch (err) {
    console.error(err);
    msg.textContent = "Impossible de lire ce fichier : " + err.message;
  }
});

// =========================================================
//  « Coller URL » : charger un article en ligne (relais CORS)
// =========================================================
// BookReeder est un site sans serveur → un relais (proxy CORS) est nécessaire pour
// récupérer une page d'un autre domaine. Test via le relais public corsproxy.io
// (articles texte uniquement ; EPUB/PDF en ligne viendront avec un relais privé).
const CORS_PROXY = "https://corsproxy.io/?url=";
$("btn-coller-url")?.addEventListener("click", collerUrl);
// Récupère et charge un article depuis une URL (presse-papier, paramètre ?url=,
// ou partage Android via le manifeste).
async function chargerArticleDepuisUrl(url) {
  const msg = $("message-chargement");
  url = (url || "").trim();
  if (!/^https?:\/\//i.test(url)) { msg.textContent = ""; return; }
  msg.textContent = "Récupération du lien…";
  try {
    const rep = await fetch(CORS_PROXY + encodeURIComponent(url));
    if (!rep.ok) throw new Error("HTTP " + rep.status);
    const type = (rep.headers.get("content-type") || "").toLowerCase();
    if (/epub|pdf|octet-stream/.test(type) || /\.(epub|pdf)(\?|#|$)/i.test(url)) { msg.textContent = ""; return; }
    const html = await rep.text();
    chargerArticle(html, url);
  } catch (e) {
    msg.textContent = "";   // erreur : on n'affiche rien (l'utilisateur refera un copier/coller)
  }
}
async function collerUrl() {
  let url = "";
  try { url = ((await navigator.clipboard.readText()) || "").trim(); }
  catch (e) { return; }                       // accès refusé / annulé : on ne fait rien (pas de message)
  if (!/^https?:\/\//i.test(url)) return;     // rien de valide dans le presse-papier : silencieux
  chargerArticleDepuisUrl(url);
}
// Ouverture via un lien partagé : ?url=… (Raccourci iOS) ou ?text=/?title= (partage
// Android via le manifeste, l'URL pouvant être noyée dans le texte). Lancé au démarrage.
(function ouvrirLienPartage() {
  try {
    const p = new URLSearchParams(location.search);
    let u = (p.get("url") || "").trim();
    if (!u) { const m = ((p.get("text") || "") + " " + (p.get("title") || "")).match(/https?:\/\/\S+/); if (m) u = m[0]; }
    if (/^https?:\/\//i.test(u)) {
      history.replaceState(null, "", location.pathname);   // nettoie l'URL (pas de rechargement en boucle)
      chargerArticleDepuisUrl(u);
    }
  } catch (e) {}
})();
// Trouve le bloc de CONTENU (façon Readability) : on score chaque conteneur selon
// le volume de ses paragraphes, en pénalisant la densité de liens (les colonnes
// « à lire aussi / bons plans » sont gorgées de liens → écartées).
function meilleurConteneur(doc) {
  const scores = new Map();
  const add = (el, s) => { if (!el || el === doc.body || el === doc.documentElement) return; scores.set(el, (scores.get(el) || 0) + s); };
  doc.querySelectorAll("p").forEach((p) => {
    const len = (p.textContent || "").trim().length;
    if (len < 25) return;
    const sc = 1 + Math.min((len / 100) | 0, 3) + len / 100;
    add(p.parentElement, sc);
    add(p.parentElement && p.parentElement.parentElement, sc / 2);
  });
  let best = doc.body, bestScore = 0;
  scores.forEach((s, el) => {
    const txt = el.textContent.length || 1;
    let lien = 0; el.querySelectorAll("a").forEach((a) => { lien += (a.textContent || "").length; });
    const adj = s * (1 - lien / txt);   // pénalise les blocs très « liens »
    if (adj > bestScore) { bestScore = adj; best = el; }
  });
  return best;
}
// Extrait { titre, source, chapitres } d'une page d'article (heuristique : on
// écarte menus/pubs/partages, on garde le bloc le plus dense, on coupe en sections
// sur les <h2>).
function extraireArticle(doc, url) {
  const meta = (sel) => { const m = doc.querySelector(sel); return m ? (m.getAttribute("content") || "").trim() : ""; };
  let titre = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') ||
    (doc.querySelector("h1") && doc.querySelector("h1").textContent.trim()) ||
    (doc.title || "").trim() || "Article";
  titre = titre.replace(/\s*[|–—\-]\s*[^|–—\-]{1,40}$/, "").trim() || titre;  // retire « | Nom du site »
  let source = ""; try { source = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
  const racine = meilleurConteneur(doc);
  racine.querySelectorAll(
    "script,style,nav,header,footer,aside,form,noscript,iframe,figcaption,button," +
    "[role=navigation],[role=banner],[role=complementary]," +
    "[class*=ad-],[class*=-ad],[id*=ad-],[class*=pub],[class*=share],[class*=social]," +
    "[class*=newsletter],[class*=comment],[class*=related],[class*=promo],[class*=cookie]," +
    "[class*=seemore],[class*=see-more],[class*=lire-aussi],[class*=read-also],[class*=teaser],[class*=encart]"
  ).forEach((e) => e.remove());
  // Découpe en parties : tout ce qui précède le 1er <h2> = « Introduction » (chapô +
  // attaque) ; chaque <h2> ouvre une nouvelle partie. On ignore les titres/paragraphes
  // qui ne sont qu'un lien (encarts « à lire aussi » insérés dans le corps).
  // Titres de sections « hors article » (renvois, encarts, références…) : dès qu'on
  // en croise une APRÈS du vrai contenu, on coupe (tout ce qui suit est du parasite).
  const normSec = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const RE_SECTION_PARASITE = /^(#|notes?( et references?)?$|references?$|voir aussi|liens? externes?|bibliographie|annexes?|sources?$|articles? connexes?|pour en savoir plus|sur le meme (sujet|theme)|dans la meme rubrique|a (lire|voir) aussi|cela vous interessera|bons plans|definitions? associees?|explorez|en continu|commentaires?|partager|sur le meme)/;
  // Un élément est-il un TITRE de section ? (générique, pas seulement <h2>) :
  // balises h1–h6, role=heading, balise maison <intertitre>, ou classe évocatrice
  // (intertitre, sous-titre, subtitle, crosshead, section-title…).
  const estTitreSection = (b) => {
    if (/^H[1-6]$/.test(b.tagName) || b.tagName === "INTERTITRE") return true;
    if ((b.getAttribute("role") || "") === "heading") return true;
    return /intertitre|inter-titre|sous-titre|sous_titre|subtitle|cross-?head|section-?title|chapter/i.test((b.className || "") + "");
  };
  const titreN = normSec(titre);
  const chapitres = []; let cur = { titre: "Introduction", texte: [] };
  let stop = false;
  const aDuContenu = () => chapitres.some((c) => c.texte.length > 120) || cur.texte.join(" ").length > 120;
  racine.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,[role=heading],intertitre,[class*=intertitre],p,blockquote,li,pre"
  ).forEach((b) => {
    if (stop) return;
    const t = (b.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 2) return;
    if (b.closest("a")) return;                                              // élément à l'intérieur d'un lien (teaser, renvoi)
    const a = b.querySelector("a");
    if (a && (a.textContent || "").trim().length >= t.length - 2) return;   // élément = simple lien
    if (estTitreSection(b)) {
      if (t.length > 140) { cur.texte.push(t); return; }   // « titre » trop long = en fait du texte
      const tn = normSec(t);
      if (tn === titreN) return;                            // c'est le titre de l'article, pas une section
      if (RE_SECTION_PARASITE.test(tn)) {
        if (aDuContenu()) {   // fin du corps : on coupe tout ce qui suit
          if (cur.texte.length) chapitres.push({ titre: cur.titre, texte: cur.texte.join("\n") });
          cur = { titre: "", texte: [] }; stop = true;
        }
        return;   // on n'ouvre jamais de partie pour un titre parasite
      }
      if (cur.texte.length) chapitres.push({ titre: cur.titre, texte: cur.texte.join("\n") });
      cur = { titre: t, texte: [] };
    } else { cur.texte.push(t); }
  });
  if (cur.texte.length) chapitres.push({ titre: cur.titre, texte: cur.texte.join("\n") });
  return { titre, source, chapitres };
}
function chargerArticle(html, url) {
  const msg = $("message-chargement");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const { titre, source, chapitres } = extraireArticle(doc, url);
  const assez = chapitres.some((c) => (c.texte || "").length > 200);
  if (!chapitres.length || !assez) { msg.textContent = ""; return; }
  carteCasseReset();
  etat.chapitresTexte = chapitres;
  etat.notes = [];
  etat.idLivre = null;
  etat.profil = {};
  etat.persos = null;
  etat.nomLivre = titre;
  etat.titreLivre = titre;
  etat.progression = 0;
  etat.articleEnAttente = { titre, url, source };   // proposera de garder à la fermeture (✖)
  rechargerReglages();
  retokeniser();
  remplirSelectChapitres();
  placerMarqueursChapitres();
  demarrerLecture();
  msg.textContent = "";
}
function carteCasseReset() { try { if (window.Chargeur) Chargeur.reinitCasse(); } catch (e) {} }

// Découpe un texte brut en « passages » d'environ 1500 mots (pour la navigation
// et des pauses de fin de chapitre raisonnables). Court → un seul bloc « Début ».
function chapitresDepuisTexte(texte) {
  const mots = (texte || "").split(/\s+/).filter(Boolean);
  if (mots.length <= 1800) return [{ titre: "Début", texte: (texte || "").trim() }];
  const taille = 1500, ch = [];
  for (let i = 0; i < mots.length; i += taille) {
    ch.push({ titre: "Passage " + (ch.length + 1), texte: mots.slice(i, i + taille).join(" ") });
  }
  return ch;
}

// Étapes communes : tokenise un aperçu, enregistre la fiche, ouvre la lecture.
async function finaliserChargement(chapitresTexte, nom, taille, titre, auteur) {
  const apercu = Chargeur.tokeniserChapitres(chapitresTexte, etat.modele.decouper);
  if (apercu.mots.length === 0) throw new Error("Aucun texte trouvé");
  const id = nom + "|" + taille;
  const fiche = {
    id, nom, titre: titre || nom, auteur: auteur || "", dateAjout: Date.now(),
    chapitresTexte, notes: [], progression: 0, total: apercu.mots.length,
  };
  await sauverLivre(fiche);
  ouvrirFiche(fiche);
  $("message-chargement").textContent = "";
}

// --- Fichier texte (.txt) ---
async function chargerTexteBrut(texte, nom, taille) {
  const msg = $("message-chargement");
  Chargeur.reinitCasse();
  msg.textContent = "Lecture du fichier…";
  const chapitresTexte = chapitresDepuisTexte(texte);
  await finaliserChargement(chapitresTexte, nom, taille, nom.replace(/\.txt$/i, ""), "");
}

// --- PDF (.pdf) via pdf.js, texte uniquement (best-effort, pas d'OCR) ---
function texteDePagePdf(tc) {
  let out = "";
  for (const it of tc.items) {
    out += it.str;
    out += it.hasEOL ? "\n" : " ";
  }
  return out;
}
function nettoyerTextePdf(t) {
  return (t || "")
    .replace(/­/g, "")                       // tirets conditionnels
    .replace(/-\n/g, "")                          // césures en fin de ligne
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")                   // paragraphes
    .replace(/([^\n])\n([^\n])/g, "$1 $2")        // lignes simples → espace
    .replace(/\s+\n/g, "\n")
    .trim();
}
async function chargerPdf(buffer, nom, taille) {
  const msg = $("message-chargement");
  Chargeur.reinitCasse();
  msg.textContent = "Lecture du PDF…";
  if (!window.pdfjsLib) throw new Error("Moteur PDF indisponible");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let texte = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    msg.textContent = `Lecture du PDF… page ${p}/${pdf.numPages}`;
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    texte += texteDePagePdf(tc) + "\n\n";
  }
  texte = nettoyerTextePdf(texte);
  if (!texte) throw new Error("PDF sans texte (peut-être scanné ?)");
  let titre = nom.replace(/\.pdf$/i, "");
  try { const m = await pdf.getMetadata(); if (m && m.info && m.info.Title) titre = m.info.Title.trim() || titre; } catch (e) {}
  await finaliserChargement(chapitresDepuisTexte(texte), nom, taille, titre, "");
}

// Charge un EPUB (ArrayBuffer), extrait le texte + les chapitres,
// l'enregistre dans la bibliothèque et démarre la lecture
async function chargerEpub(buffer, nom, taille) {
  const msg = $("message-chargement");
  msg.textContent = "Lecture du fichier…";
  try {
    // Garde-fou : un EPUB est une archive ZIP → ses 2 premiers octets sont « PK »
    // (0x50 0x4B). Sinon, inutile de solliciter epub.js (qui peut se bloquer sur un
    // fichier invalide) : on signale tout de suite un fichier non valide (page web
    // renommée, téléchargement échoué, format inattendu).
    const sig = new Uint8Array(buffer.slice(0, 2));
    if (sig[0] !== 0x50 || sig[1] !== 0x4B) {
      const tete = new TextDecoder("latin1").decode(new Uint8Array(buffer.slice(0, 64))).trimStart().toLowerCase();
      const estHtml = tete.startsWith("<!doctype html") || tete.startsWith("<html") || tete.startsWith("<?xml");
      throw new Error(estHtml
        ? "ce fichier est une page web, pas un EPUB (téléchargement probablement échoué)."
        : "ce fichier n'est pas un EPUB valide (archive ZIP attendue).");
    }
    const livre = ePub(buffer);
    // Garde-fou : certains EPUB bloquent epub.js indéfiniment à l'ouverture. On
    // abandonne au bout de 15 s avec un message clair plutôt que de geler l'appli.
    await Promise.race([
      livre.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error("ouverture trop longue (fichier peut-être non standard ou abîmé)")), 15000)),
    ]);
    // Lit le CSS du livre pour reproduire les transformations de casse
    // (titres en petites capitales / majuscules), fidèlement au rendu d'origine.
    Chargeur.reinitCasse();
    try {
      if (window.JSZip) {
        const zip = await JSZip.loadAsync(buffer);
        const fcss = Object.keys(zip.files).filter((f) => /\.css$/i.test(f));
        const css = (await Promise.all(fcss.map((f) => zip.files[f].async("string")))).join("\n");
        Chargeur.preparerCasse(css);
      }
    } catch (e) { Chargeur.reinitCasse(); }
    const { chapitresTexte, notes } = await Chargeur.extraireLivre(livre);
    const apercu = Chargeur.tokeniserChapitres(chapitresTexte, etat.modele.decouper);
    if (apercu.mots.length === 0) throw new Error("Aucun texte trouvé");

    // Titre et auteur depuis les métadonnées de l'EPUB (sinon nom de fichier).
    // Le champ peut être une chaîne ou un objet ({ name } / { value }) selon l'EPUB.
    const texteMeta = (v) => {
      if (!v) return "";
      if (typeof v === "string") return v.trim();
      return String(v.name || v.value || v["#text"] || "").trim();
    };
    let titre = nom.replace(/\.epub$/i, "");
    let auteur = "";
    try {
      const meta = (await livre.loaded.metadata) || {};
      const pkg = (livre.packaging && livre.packaging.metadata) || {};
      titre = texteMeta(meta.title) || texteMeta(pkg.title) || titre;
      auteur = texteMeta(meta.creator) || texteMeta(pkg.creator) ||
               texteMeta(meta.author) || texteMeta(pkg.author);
    } catch (e) { /* pas de métadonnées : on garde le nom de fichier */ }

    const id = nom + "|" + taille;
    const fiche = {
      id, nom, titre, auteur, dateAjout: Date.now(),
      chapitresTexte, notes: notes || [], progression: 0, total: apercu.mots.length,
    };
    await sauverLivre(fiche);
    ouvrirFiche(fiche);
  } catch (err) {
    console.error(err);
    msg.textContent = "Impossible de lire ce fichier : " + err.message;
  }
}

// Reconstruit le texte par chapitre depuis une ancienne fiche (mots + offsets)
function reconstruireChapitresTexte(fiche) {
  if (!fiche.mots || !fiche.mots.length) return [{ titre: "Début", texte: "" }];
  const ch = (fiche.chapitres && fiche.chapitres.length) ? fiche.chapitres : [{ titre: "Début", debut: 0 }];
  return ch.map((c, i) => ({
    titre: c.titre,
    texte: fiche.mots.slice(c.debut, ch[i + 1] ? ch[i + 1].debut : fiche.mots.length).join(" "),
  }));
}

// Charge en mémoire une fiche de la bibliothèque et démarre la lecture
function ouvrirFiche(fiche) {
  etat.chapitresTexte = fiche.chapitresTexte && fiche.chapitresTexte.length
    ? fiche.chapitresTexte : reconstruireChapitresTexte(fiche);
  etat.notes = fiche.notes || [];
  etat.idLivre = fiche.id;
  etat.nomLivre = fiche.nom;
  etat.titreLivre = fiche.titre || fiche.nom;
  etat.progression = fiche.progression != null ? fiche.progression
    : (fiche.total ? (fiche.index || 0) / fiche.total : 0);
  etat.profil = fiche.profil || {};        // profil de lecture du livre (v2.95)
  etat.persos = fiche.persos || null;      // personnages détectés (v2.96), scan mis en cache
  rechargerReglages();                      // applique les réglages du livre (sinon global)
  retokeniser();
  // Reprise précise : on recule au DÉBUT de la phrase en cours (plutôt que de
  // redémarrer pile sur le mot quitté, souvent au milieu d'une phrase), pour
  // retrouver le fil sans relire. Uniquement à l'ouverture d'un livre.
  if (etat.index > 0) {
    etat.index = debutPhraseAvant(etat.index);
    etat.progression = etat.index / Math.max(1, etat.mots.length - 1);
  }
  remplirSelectChapitres();
  placerMarqueursChapitres();
  demarrerLecture();
}

// Texte de démo (pour tester sans EPUB)
const TEXTE_DEMO = `La réception avait eu lieu dans la demeure de Lucinda Joffrey. Sir Richard était absent : un diplomate de sa stature n’aurait jamais toléré un amusement aussi frivole. Les soirées d’anguille électrique faisaient fureur à Londres depuis peu, mais, en raison de la rareté de ces créatures, les fêtes privées demeuraient exceptionnelles.
— Le record est de quarante-deux personnes d’un seul coup ! lança Caroline, les yeux brillants.
— Quarante-deux ? répéta Lord John, sceptique. Vous exagérez sûrement.
— Pas le moins du monde. Approchez donc, major, et regardez-la de plus près.
Il se pencha au-dessus de l’aquarium. La créature était l’animal le plus singulier qu’il eût jamais vu : près de trois pieds de long, de petits yeux ronds et ternes, un corps trapu, une tête plate.
— On dirait qu’un sculpteur débutant l’a modelée dans l’argile, murmura-t-il.
— Voyons, vous êtes injuste, protesta Caroline. Observez cette nageoire… elle ondule comme un rideau de mousseline sous la brise.
— Un rideau de mousseline ! Vous parlez comme un poète, ma chère.
— Un poète ? dit une voix amusée derrière eux. Les talents de notre galant major ne connaissent-ils donc aucune limite ?
Lord John se retourna en réprimant une grimace, et s’inclina.
— Monsieur Nicholls, fit-il avec une courtoisie glacée. Je ne vous savais pas amateur de poissons.
— D’anguilles, major, corrigea Edwin Nicholls en souriant. Et de bonne compagnie. Dînerez-vous avec nous ?
— Une autre fois, peut-être, répondit-il. Le devoir m’appelle.
Caroline soupira tandis qu’il s’éloignait.
— Toujours le devoir… Cet homme finira par s’ennuyer à mourir.`;

// Chapitre 2 inventé, riche en dialogues (test chapitrage + annotations).
const TEXTE_DEMO2 = `Le lendemain matin, une brume épaisse montait de la Tamise et noyait les quais d’un voile gris. Lord John remonta le col de son manteau et pressa le pas vers Whitehall.
— Vous êtes en retard, lança Caroline sans même se retourner.
— La faute à ce brouillard, répondit-il. On n’y voit pas à dix pas.
— Toujours une excuse !
— Ce n’est pas une excuse, c’est un fait.
Elle finit par lui faire face, un sourire moqueur au coin des lèvres.
— Et que comptez-vous faire de votre petite protégée ? demanda-t-elle.
— L’étudier, dit-il simplement. La comprendre.
— La comprendre ? ricana un homme adossé contre le mur. Vous perdez votre temps, major.
Lord John ne releva pas l’impertinence. Il savait que la curiosité valait toujours mieux que le mépris.
— Peut-être, concéda-t-il enfin. Mais le temps perdu à chercher n’est jamais tout à fait perdu.
Caroline le regarda un long moment, puis éclata de rire.
— Vous êtes incorrigible !
— C’est ce qu’on me dit souvent, avoua-t-il en souriant.`;

$("btn-demo").addEventListener("click", () => {
  etat.chapitresTexte = [
    { titre: "Chapitre 1 - L'anguille", texte: TEXTE_DEMO },
    { titre: "Chapitre 2 - La brume", texte: TEXTE_DEMO2 },
  ];
  etat.notes = [];
  etat.idLivre = null;
  etat.profil = {};
  etat.persos = null;
  etat.nomLivre = "Démo";
  etat.titreLivre = "Texte de démo";
  etat.progression = 0;
  rechargerReglages();   // démo : pas de profil (idLivre nul) → réglages globaux
  retokeniser();
  injecterNotesDemo();   // 2 annotations d'exemple : Londres¹, Lord John²
  remplirSelectChapitres();
  placerMarqueursChapitres();
  demarrerLecture();
});

// Ajoute 2 annotations d'exemple à la démo (Londres, Lord John), rattachées au
// dernier mot de chaque occurrence, pour illustrer l'exposant + la bulle.
function injecterNotesDemo() {
  const notes = [
    { num: "1", cle: /^londres/i, texte: "Londres : capitale du Royaume-Uni, sur la Tamise ; cœur politique et culturel de l'Angleterre." },
    // Sur « John » (de « Lord John ») pour que l'exposant tombe après le nom complet.
    { num: "2", cle: /^john/i,    texte: "Lord John Grey : officier britannique, personnage élégant et perspicace, narrateur de plusieurs récits de Diana Gabaldon." },
    // Chapitre 2 :
    { num: "3", cle: /^tamise/i,    texte: "La Tamise : fleuve traversant Londres, long de 346 km, bordé par les grands monuments de la capitale." },
    { num: "4", cle: /^whitehall/i, texte: "Whitehall : avenue de Londres concentrant les ministères ; par extension, le siège du gouvernement britannique." },
  ];
  etat.notes = notes.map((n) => ({ num: n.num, texte: n.texte }));
  const map = new Map();
  const place = notes.map(() => false);   // une seule occurrence par note
  for (let i = 0; i < etat.mots.length; i++) {
    const motNet = (etat.mots[i] || "").replace(/[^\p{L}]/gu, "");
    notes.forEach((n, id) => {
      if (!place[id] && n.cle.test(motNet)) {
        place[id] = true;
        if (!map.has(i)) map.set(i, []);
        map.get(i).push(etat.notes[id]);
      }
    });
  }
  etat.noteParMot = map;
}

// — parsing migré dans chargeur.js —

// (Re)tokenise le livre courant avec le modèle actif, en conservant la
// position relative (progression) de lecture.
function retokeniser() {
  const { mots, chapitres, debuts, refs } = Chargeur.tokeniserChapitres(etat.chapitresTexte, etat.modele.decouper);
  etat.mots = mots;
  etat.chapitresBrut = chapitres;     // TOC d'origine (avant nettoyage / mode)
  initModeTOC();                      // détermine le mode et construit etat.chapitres
  etat.debutsPhrase = debuts || new Set();
  // Table mot -> annotations (pour l'affichage en exposant et la bulle en loupe).
  const notes = etat.notes || [];
  const map = new Map();
  (refs || []).forEach((r) => {
    const n = notes[r.noteId];
    if (!n) return;
    if (!map.has(r.motIndex)) map.set(r.motIndex, []);
    map.get(r.motIndex).push(n);
  });
  etat.noteParMot = map;
  etat.couleurParMot = null;   // recalculé à la demande si le multicolore est actif
  recalcLocuteurs();   // multicolore : charge le moteur au besoin et calcule les couleurs
  const total = Math.max(1, etat.mots.length);
  etat.index = Math.min(Math.round((etat.progression || 0) * (total - 1)), total - 1);
  if (etat.index < 0 || !isFinite(etat.index)) etat.index = 0;
}

// — parsing migré dans chargeur.js —

// =========================================================
//  Découpe du texte en mots
//  Garde les apostrophes internes (l'homme) et rattache
//  les guillemets isolés au mot voisin pour ne pas les
//  afficher seuls.
// =========================================================
function decouperEnMots(texte) {
  const bruts = texte
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  // Règle générale : un jeton qui ne contient AUCUNE lettre ni chiffre
  // (tiret, guillemet, ponctuation, astérisque, etc.) ne doit jamais
  // s'afficher seul. On le colle à un mot voisin :
  //  - ponctuation « ouvrante » (guillemets/parenthèses/tirets ouvrants) → mot SUIVANT ;
  //  - tout le reste (ponctuation fermante ou ambiguë) → mot PRÉCÉDENT.
  const estMot = (s) => /[\p{L}\p{N}]/u.test(s);
  const ouvrante = /^[«“‘"'(\[{¿¡—–―‒*\-]+$/; // jetons à coller au mot SUIVANT

  // Espace INSÉCABLE entre un signe et le mot rattaché : un signe ne passe
  // jamais seul à la ligne (mode loupe), et la typo française est respectée.
  const NB = " ";
  const mots = [];
  let enAttente = "";   // ponctuation ouvrante à coller au prochain mot
  for (const brut of bruts) {
    if (!estMot(brut)) {                 // jeton sans lettre ni chiffre
      if (ouvrante.test(brut) || mots.length === 0) {
        enAttente = enAttente ? enAttente + NB + brut : brut;   // → mot suivant
      } else {
        mots[mots.length - 1] += NB + brut;                     // → mot précédent
      }
      continue;
    }
    const mot = enAttente ? enAttente + NB + brut : brut;
    enAttente = "";
    mots.push(mot);
  }
  // Reliquat (texte finissant par de la ponctuation) : on le colle au dernier mot.
  if (enAttente) {
    if (mots.length > 0) mots[mots.length - 1] += NB + enAttente;
    else mots.push(enAttente);
  }
  return mots;
}

// =========================================================
//  Affichage RSVP avec point ORP
// =========================================================
// Longueur "visible" d'un jeton (sans les espaces de ponctuation rattachée)
function longueurVisible(mot) {
  return mot.replace(/\s+/g, "").length;
}

// Mot se terminant par un signe de ponctuation (coupe le groupe après lui)
const PONCT_COUPE = /[.,;:!?…]["»”'’)\]]*$/;

// Titres / civilités toujours suivis d'un nom propre (à ne jamais séparer du nom).
// Le point de l'abréviation ne doit pas couper le groupe.
const HONORIFIQUE = /^(MM?|Mr|Mrs|Ms|Mme|Mmes|Mlle|Mlles|Dr|Pr|Prof|Me|Mgr|St|Ste|Sts|Stes|Cie|Cap|Cdt|Col|Gal|Gén|Lt|Sgt|Adj|Rev|Hon|Vve)\.?$/;
function estHonorifique(mot) {
  return HONORIFIQUE.test((mot || "").replace(/^[^\p{L}]+/u, ""));
}

// Construit le groupe de mots à afficher à partir de `start`, en respectant :
//  - un titre (M., Mme, Mlle, Mrs…) reste collé au nom propre qui suit ;
//  - une suite de mots à Majuscule (prénom + nom) est groupée même si un seul
//    mot est demandé ;
//  - le maximum demandé (etat.nbMots) sinon ;
//  - un mot très long (> 12 caractères) s'affiche seul ;
//  - on coupe le groupe après tout signe de ponctuation (. , ; : ! ? …),
//    donc on n'enchaîne jamais par-dessus une ponctuation.
function construireChunkDepuis(start) {
  // Mode « 1 (strict) » : un seul mot, on contourne le groupage des noms propres.
  // (la ponctuation reste collée au mot via les espaces insécables).
  if (etat.modeStrict) return { texte: etat.mots[start], nb: 1 };
  // Nom propre : titre + nom, ou 2 mots (ou plus) à majuscule consécutifs
  const m0 = etat.mots[start];
  if (estMotMajuscule(m0) && (estHonorifique(m0) || estMotMajuscule(etat.mots[start + 1]))) {
    const parts = [];
    for (let i = start; i < etat.mots.length; i++) {
      const mot = etat.mots[i];
      parts.push(mot);
      if (estHonorifique(mot)) continue;              // un titre ne coupe jamais
      if (parts.length >= 3) break;                   // jamais plus de 3 mots groupés
      if (PONCT_COUPE.test(mot)) break;               // ponctuation finale -> fin du nom
      if (estDebutPhrase(i + 1)) break;               // nouveau bloc/phrase -> ne pas happer
      if (!estMotMajuscule(etat.mots[i + 1])) break;  // mot suivant pas en majuscule -> fin
    }
    return { texte: parts.join(" "), nb: parts.length };
  }
  // Groupement normal
  const P = etat.modele.params;
  const motLongMax = P.motLongMax;
  const lettresMax = P.lettresMax || 16;
  const parts = [];
  let lettres = 0;
  for (let i = start; i < start + etat.nbMots && i < etat.mots.length; i++) {
    const mot = etat.mots[i];
    const lg = longueurVisible(mot);
    const longMot = lg > motLongMax;
    // Un mot long démarre un nouveau groupe ; un groupe ne dépasse jamais
    // `lettresMax` lettres ; et on ne fusionne pas par-dessus un début de bloc.
    if (parts.length > 0 && (longMot || lettres + lg > lettresMax || estDebutPhrase(i))) break;
    parts.push(mot);
    lettres += lg;
    if (longMot || PONCT_COUPE.test(mot)) break;   // mot long seul, ou coupe après ponctuation
  }
  return { texte: parts.join(" "), nb: parts.length || 1 };
}

// Mot commençant par une majuscule (prénom/nom), tiret/guillemet de tête ignorés
function estMotMajuscule(mot) {
  return commenceMajuscule(mot);
}

// Réduit la police si le groupe dépasse le cadre. Le texte étant centré sur
// la lettre ORP (au milieu de l'écran), il faut que le plus grand des deux
// côtés (gauche / droite du repère) tienne dans la moitié du cadre.
function ajusterTaillePolice() {
  motAffiche.style.fontSize = "";
  const cadre = $("cadre");
  const dispo = (zoneMot.classList.contains("avec-cadre")
    ? cadre.clientWidth
    : window.innerWidth * 0.9) - 32;
  if (dispo <= 0) return;

  const boite = motAffiche.getBoundingClientRect();
  const total = boite.width;
  const orp = motAffiche.querySelector(".orp");
  let besoin = total;                       // sans ORP : largeur totale centrée
  if (orp) {
    const r = orp.getBoundingClientRect();
    const centre = r.left - boite.left + r.width / 2;
    besoin = 2 * Math.max(centre, total - centre); // largeur centrée sur l'ORP
  }
  if (besoin > dispo) {
    const base = parseFloat(getComputedStyle(motAffiche).fontSize);
    motAffiche.style.fontSize = (base * dispo / besoin) + "px";
  }
}

function afficherChunk() {
  const { texte: brut, nb } = etat.modele.chunk(etat.index);
  etat.nbCourant = nb;
  if (!brut) return;
  // Masquage optionnel des signes de dialogue (cadratins/guillemets) quand
  // l'effet « Couleurs » est actif — la couleur marque déjà le locuteur.
  const texte = (!etat.afficherSignesDlg && effetDialogue("multicolore")) ? masquerSignesDlg(brut) : brut;

  const idxOrp = etat.orpActif ? etat.modele.orp(texte) : -1;
  motAffiche.innerHTML = construireHtml(texte, idxOrp);
  appliquerEffetsDialogue();   // italique / fondu / couleur du locuteur
  ajusterTaillePolice();

  if (idxOrp < 0) {
    // Pas d'ORP : on centre tout le chunk
    motAffiche.style.setProperty("--decalage-orp",
      (motAffiche.getBoundingClientRect().width / 2) + "px");
  } else {
    // Aligne la lettre pivot (span .orp) pile au centre, quel que soit
    // le reste du contenu (gras bionic compris)
    const orp = motAffiche.querySelector(".orp");
    const boite = motAffiche.getBoundingClientRect();
    const r = orp.getBoundingClientRect();
    motAffiche.style.setProperty("--decalage-orp",
      (r.left - boite.left + r.width / 2) + "px");
  }
  majProgression();
}

// Applique les effets de dialogue (italique / fondu / couleur du locuteur) au
// cartouche, selon que le mot courant fait partie d'une réplique.
function appliquerEffetsDialogue() {
  // Un mot « de dialogue » = il a une couleur de locuteur (multicolore) OU il est
  // dans une réplique (pour italique/fondu, indépendants du multicolore).
  const couleur = effetDialogue("multicolore") && etat.couleurParMot
    ? (etat.couleurParMot.get(etat.index) || "") : "";
  const enDial = !!couleur || dansDialogue(etat.index);
  motAffiche.style.setProperty("--couleur-dialogue", couleur || "");
  motAffiche.classList.toggle("dlg-couleur", !!couleur);
  // Fondu : la durée = temps d'affichage du mot, connu seulement dans tick().
  // Ici on mémorise juste s'il s'applique et on nettoie la classe.
  etat._enDialFondu = enDial && effetDialogue("fondu");
  motAffiche.classList.remove("dlg-fondu");
}

// Construit le HTML du chunk : gras bionic optionnel + lettre pivot ORP.
// On échappe chaque caractère (le texte vient de l'EPUB).
function construireHtml(chunk, idxOrp) {
  const echappe = (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c;

  const mots = chunk.split(" ");
  let html = "";
  let i = 0; // index global du caractère dans le chunk

  mots.forEach((mot, m) => {
    if (m > 0) { // espace entre les mots
      html += (i === idxOrp) ? '<span class="orp"> </span>' : " ";
      i++;
    }
    // Bionic : on met en gras le DÉBUT du mot (point de fixation), à partir
    // de sa première lettre et sur une fraction des lettres selon sa longueur.
    const gras = etat.bionic ? etat.modele.gras(mot) : null;
    for (let j = 0; j < mot.length; j++, i++) {
      let c = echappe(mot[j]);
      // ORP en interne pour que sa couleur rouge reste prioritaire,
      // bionic en externe pour la graisse + couleur du début de mot
      if (i === idxOrp) c = '<span class="orp">' + c + "</span>";
      if (gras && j >= gras.debut && j < gras.fin) c = '<span class="bio">' + c + "</span>";
      html += c;
    }
    // Repère d'annotation : marqueur si ce mot porte une note consultable en
    // mode loupe. Discret (couleur de la police) ou « accentué » (couleur
    // d'accentuation en cours). N'entre pas dans le calcul de l'ORP.
    if (etat.noteParMot && etat.noteParMot.has(etat.index + m)) {
      const mk = MARQUEURS[etat.marqueurNote] || MARQUEURS.etoile;
      if (mk && mk.car) {
        const accent = mk.accent ? " accent" : "";
        if (mk.car === "•") {
          // Pastille pleine DESSINÉE (cercle CSS), sur la ligne du texte.
          html += '<span class="marque-pastille' + accent + '" aria-hidden="true"></span>';
        } else {
          // * ^ ° : collés au mot (pas d'espace) ; # garde son espace.
          const colle = (mk.car === "*" || mk.car === "^" || mk.car === "°") ? " collee" : "";
          html += '<span class="marque-note' + accent + colle + '" aria-hidden="true">' + mk.car + "</span>";
        }
      }
    }
  });
  return html;
}

// Bornes (caractères) du début de mot à mettre en gras pour le bionic.
// Le gras commence à la 1re LETTRE (jamais sur un tiret/guillemet de tête)
// et couvre les premières lettres selon la longueur (catégories court/moyen/long).
function bornesGras(mot) {
  const lettres = [];
  for (let k = 0; k < mot.length; k++) {
    if (/[\p{L}\p{N}]/u.test(mot[k])) lettres.push(k);
  }
  const n = lettres.length;
  if (n === 0) return null;            // jeton sans lettre : pas de gras
  let nb;                              // nombre de lettres en gras
  if (n <= 3) nb = 1;
  else if (n <= 6) nb = 2;
  else if (n <= 9) nb = 3;
  else nb = Math.ceil(n * 0.4);
  nb = Math.min(nb, n);
  return { debut: lettres[0], fin: lettres[nb - 1] + 1 };
}

// Rang de la lettre pivot selon le nombre de lettres (table Spritz/OpenSpritz).
// Le point de reconnaissance est légèrement à GAUCHE du centre ; plus le mot
// est long, plus il se décale à gauche.
function rangPivot(n) {
  if (n <= 1) return 0;
  if (n <= 5) return 1;
  if (n <= 9) return 2;
  if (n <= 13) return 3;
  return 4;
}

// Position (index caractère) de la lettre pivot ORP dans le chunk.
// On ne considère QUE les lettres et chiffres : les apostrophes, tirets,
// guillemets, espaces et ponctuation ne peuvent jamais être le repère.
function calculerOrp(chunk) {
  const lettres = [];
  for (let i = 0; i < chunk.length; i++) {
    if (/[\p{L}\p{N}]/u.test(chunk[i])) lettres.push(i);
  }
  if (lettres.length === 0) return -1;
  return lettres[rangPivot(lettres.length)];
}

// =========================================================
//  Lecture (avance automatique)
// =========================================================
// Début de réplique / de dialogue : tiret ou guillemet ouvrant en tête de mot.
const DEBUT_REPLIQUE = /^[—–―‒\-«"“]/;

// Le mot est-il dans une ligne de dialogue ? (sa phrase commence par un
// tiret ou un guillemet ouvrant)
function dansDialogue(i) {
  const debut = debutPhraseAvant(i);
  return DEBUT_REPLIQUE.test((etat.mots[debut] || "").trimStart());
}

// (Détection du locuteur / incises / multicolore : déplacée dans dialogues.js,
//  chargé à la demande quand Multicolore ou Élocution est actif.)
// Couleurs des dialogues (principal, secondaire 1, secondaire 2). Pilotées par la
// palette choisie dans les Réglages (etat.paletteDialogue) ; valeurs par défaut.
let COUL_PRINCIPAL = "#74a228", COUL_SEC1 = "#aa4521", COUL_SEC2 = "#a22878";
// Catalogue des palettes par thème (3 couleurs chacune). Mêmes noms d'un thème à
// l'autre ; teintes ajustées au fond (clair pour Sépia, vives pour les sombres).
// 4 palettes par thème, calibrées sur le fond :
//  Midnight  → contraste MOYEN (couleurs franches mais pas criardes)
//  Deep Black→ contraste FORT (couleurs vives, lumineuses)
//  Dark Mono → contraste FAIBLE (teintes douces, désaturées)
//  Sépia     → couleurs FONCÉES et PEU saturées (lisibles sur beige clair)
const PALETTES = {
  midnight: [
    { nom: "Mars",      c: ["#cf5a33", "#b0479a", "#74a228"] },
    { nom: "Lagon",     c: ["#3fa9c9", "#8abf3a", "#d98a3a"] },
    { nom: "Verger",    c: ["#8abf3a", "#d3a946", "#d22d21"] },
    { nom: "Aurore",    c: ["#5ac0a0", "#d9b53f", "#c95a8f"] },
  ],
  // Mêmes palettes que Midnight, déclinées selon le contraste de chaque thème :
  black: [   // Deep Black : teintes franches (échangées depuis Sépia)
    { nom: "Néon",      c: ["#bc4824", "#8f3d8f", "#278647"] },
    { nom: "Cosmos",    c: ["#2e6f9e", "#309161", "#b67820"] },
    { nom: "Spectre",   c: ["#358d35", "#c48c1c", "#b62d20"] },
    { nom: "Ombre",     c: ["#3a86c4", "#c0392b", "#27a06a"] },
  ],
  mono: [    // Dark Mono : teintes douces (désaturées, saturation +15 %)
    { nom: "Galet",     c: ["#b07867", "#987474", "#77914d"] },
    { nom: "Brouillard",c: ["#719eac", "#8da36b", "#bc946b"] },
    { nom: "Lichen",    c: ["#8da36b", "#b8a575", "#b9564e"] },
    { nom: "Brume",     c: ["#7d8fb0", "#9bb07d", "#b08a7d"] },
  ],
  sepia: [   // Sépia : teintes vives + claires (échangées depuis Deep Black)
    { nom: "Terre",     c: ["#e27e5d", "#cd67b8", "#98d82f"] },
    { nom: "Ardoise",   c: ["#67c2de", "#a8d85e", "#eaa966"] },
    { nom: "Automne",   c: ["#a8d85e", "#e5c371", "#eb5045"] },
    { nom: "Miel",      c: ["#e0a85d", "#7ec2de", "#d86f9f"] },
  ],
};
// Palettes affichées pour un thème = 3 palettes fixes + 1 palette « Accentuation »
// (dynamique : la couleur d'accentuation actuelle, déclinée en 3 tons).
function palettesDuTheme(cle) {
  return (PALETTES[cle] || PALETTES.midnight).concat([paletteAccentuation()]);
}
// Thème actif (clé de PALETTES) ; mis à jour par appliquerTheme().
function themeActif() {
  const cl = document.documentElement.className;
  if (/theme-mono/.test(cl)) return "mono";
  if (/theme-black/.test(cl)) return "black";
  if (/theme-sepia/.test(cl)) return "sepia";
  return "midnight";
}

// --- Conversions couleur (pour la palette « Accentuation » en 3 tons) ---
function hexVersRgb(h) {
  h = (h || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbVersHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hsl(h, s, l) {
  return "hsl(" + Math.round(h) + "," + Math.round(Math.max(0, Math.min(100, s))) + "%," + Math.round(Math.max(0, Math.min(100, l))) + "%)";
}
// --- Conversions sRGB ↔ Lab (D65) pour décliner une couleur perceptuellement ---
function rgbVersLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function labVersRgb(L, a, bb) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - bb / 200;
  const f3 = (t) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  x = 0.95047 * f3(x); y = f3(y); z = 1.08883 * f3(z);
  let R = x * 3.2406 - y * 1.5372 - z * 0.4986;
  let G = -x * 0.9689 + y * 1.8758 + z * 0.0415;
  let B = x * 0.0557 - y * 0.2040 + z * 1.0570;
  const dl = (v) => { v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(v * 255))); };
  return [dl(R), dl(G), dl(B)];
}
function rgbHex(r, g, b) { return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join(""); }
// HSL (h en degrés, s/l en %) → hex « #rrggbb » (pour les pastilles et la coloration).
function hslVersHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return rgbHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}
// Couleur d'accentuation en [r,g,b] (résout hex OU hsl(...)).
function accentRgb() {
  const c = couleurAccentuation();
  if (/^#?[0-9a-f]{3,6}$/i.test(c)) return hexVersRgb(c);
  const m = c.match(/hsl\(\s*([\d.]+)[, ]+([\d.]+)%[, ]+([\d.]+)%/i);
  if (m) { const t = document.createElement("span"); t.style.color = c; document.body.appendChild(t);
    const rgb = getComputedStyle(t).color.match(/\d+/g); t.remove();
    if (rgb) return rgb.slice(0, 3).map(Number); }
  return [242, 92, 84];
}
// Couleur d'accentuation effective (résout currentColor / la variable CSS).
function couleurAccentuation() {
  let c = (getComputedStyle(document.documentElement).getPropertyValue("--orp-couleur") || "").trim();
  if (!c || c === "currentColor") c = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#f25c54").trim();
  return c;
}
// Palette « Accentuation » : la couleur d'accentuation déclinée en 3 tons (même
// teinte/saturation, luminosités différentes) pour distinguer les voix sans
// changer de couleur de base.
function paletteAccentuation() {
  // Camaïeu via l'espace Lab : on garde L (clarté) et a (rouge↔vert), et on décale
  // le canal b (bleu↔jaune) de ±60 → 3 tons proches, perceptuellement cohérents.
  const [r, g, b] = accentRgb();
  const [L, A, B] = rgbVersLab(r, g, b);
  const v = (db) => rgbHex(...labVersRgb(L, A, B + db));
  return { nom: "Accentuation +", accent: true, c: [v(0), v(-60), v(60)] };
}
// Couleurs courantes de la palette PERSONNALISÉE (Voix 1/2/3), mémorisées.
let couleursPerso = ["#74a228", "#aa4521", "#a22878"];
// Applique la palette choisie au thème courant. `nom` = nom d'une palette du thème,
// ou "perso" pour la palette personnalisée (3 roues chromatiques).
// Applique une palette. `theme` = thème SOURCE de la palette (peut différer du
// thème de fond : palette et thème sont indépendants). Par défaut, le thème mémorisé.
// Toutes les palettes, tous thèmes confondus (+ « Accentuation »).
function palettesToutes() {
  const out = [];
  ORDRE_THEMES.forEach((t) => (PALETTES[t] || []).forEach((p) => out.push({ nom: p.nom, c: p.c, theme: t })));
  out.push(Object.assign({ theme: "" }, paletteAccentuation()));
  return out;
}
// Couleur de police effective (pour « Aucune » : dialogues en couleur uniforme).
function couleurPoliceCourante() {
  const c = (getComputedStyle(document.documentElement).getPropertyValue("--couleur-police") || "").trim();
  return c || (getComputedStyle(document.documentElement).getPropertyValue("--texte") || "#dddddd").trim();
}
function appliquerPaletteDialogue(nom, theme) {
  if (nom === "aucune") {
    etat.paletteDialogue = "aucune"; etat.paletteTheme = "";
  } else if (nom === "perso") {
    etat.paletteDialogue = "perso"; etat.paletteTheme = "";
    [COUL_PRINCIPAL, COUL_SEC1, COUL_SEC2] = couleursPerso;
  } else {
    let p = null, src = theme || "";
    if (src) p = palettesDuTheme(src).find((x) => x.nom === nom);
    if (!p) { for (const t of ORDRE_THEMES) { const f = (PALETTES[t] || []).find((x) => x.nom === nom); if (f) { p = f; src = t; break; } } }
    if (!p && nom === "Accentuation +") { p = paletteAccentuation(); src = ""; }
    if (!p) { src = themeActif(); p = palettesDuTheme(src)[0]; }
    etat.paletteTheme = src; etat.paletteDialogue = p.nom;
    [COUL_PRINCIPAL, COUL_SEC1, COUL_SEC2] = p.c;
  }
  try {
    localStorage.setItem("bookreeder-palette-dialogue", etat.paletteDialogue);
    localStorage.setItem("bookreeder-palette-theme", etat.paletteTheme || "");
  } catch (e) {}
  if (etat.couleurParMot && window.MoteurDialogues) window.MoteurDialogues.calculerLocuteurs();   // recalcule avec les nouvelles couleurs
  if (!ecranLecture.classList.contains("cache")) afficherChunk();
  majBoutonPalette();
}
// Couleurs effectives de la palette courante (pour le bouton + les pastilles).
function couleursPaletteCourante() {
  if (etat.paletteDialogue === "aucune") { const c = couleurPoliceCourante(); return [c, c, c]; }
  if (etat.paletteDialogue === "perso") return couleursPerso;
  const liste = palettesDuTheme(etat.paletteTheme || themeActif());
  const p = liste.find((x) => x.nom === etat.paletteDialogue) || liste[0];
  return p.c;
}
// Met à jour le(s) bouton(s) palette (nom + 3 pastilles de la palette courante).
function majBoutonPalette() {
  const nom = etat.paletteDialogue === "aucune" ? "Aucune"
    : etat.paletteDialogue === "perso" ? "Perso" : (etat.paletteDialogue || "Mars");
  const past = couleursPaletteCourante().map((col) => '<span class="pastille-mini" style="background:' + col + '"></span>').join("");
  document.querySelectorAll(".btn-palette-nom").forEach((e) => { e.textContent = nom; });
  document.querySelectorAll(".btn-palette-pastilles").forEach((e) => { e.innerHTML = past; });
}
const NOMS_THEMES = { midnight: "Midnight", mono: "Dark Mono", black: "Deep Black", sepia: "Sépia" };
const ORDRE_THEMES = ["midnight", "mono", "black", "sepia"];
let paletteThemeApercu = "midnight";   // thème dont on visualise les palettes
let palettePreview = null;             // sélection PROVISOIRE (appliquée à la fermeture)
// Couleurs d'une palette par son nom (pour l'aperçu provisoire).
function couleursDePalette(nom) {
  if (nom === "aucune") { const c = couleurPoliceCourante(); return [c, c, c]; }
  if (nom === "perso") return couleursPerso;
  if (nom === "Accentuation +") return paletteAccentuation().c;
  for (const t of ORDRE_THEMES) { const p = (PALETTES[t] || []).find((x) => x.nom === nom); if (p) return p.c; }
  const c = couleurPoliceCourante(); return [c, c, c];
}
// Liste : palettes du thème, puis « Aucune », « Accentuation + », « Perso ».
// Les 3 roues Perso sont hors liste, dessous.
function rendrePaletteListe() {
  $("palette-titre-theme").textContent = "Palette " + (NOMS_THEMES[paletteThemeApercu] || "");
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const item = (label, cols, dataNom, theme) => {
    const sel = palettePreview === dataNom ? " choisie" : "";
    return '<button class="palette-item' + sel + '" data-nom="' + esc(dataNom) + '" data-theme="' + (theme || "") + '" data-couleurs="' + cols.join(",") + '">' +
      '<div class="palette-tete"><b>' + esc(label) + '</b><span class="pastilles-mini">' +
      cols.map((c) => '<span class="pastille-mini" style="background:' + c + '"></span>').join("") + '</span></div></button>';
  };
  const fp = couleurPoliceCourante();
  let html = "";
  (PALETTES[paletteThemeApercu] || []).forEach((p) => { html += item(p.nom, p.c, p.nom, paletteThemeApercu); });
  html += item("Aucune", [fp, fp, fp], "aucune", "") +
    item("Accentuation +", paletteAccentuation().c, "Accentuation +", "") +
    item("Perso", couleursPerso, "perso", "");
  $("palette-liste").innerHTML = html;
  ["voix1-couleur", "voix2-couleur", "voix3-couleur"].forEach((id, i) => { const el = $(id); if (el && /^#/.test(couleursPerso[i] || "")) el.value = couleursPerso[i]; });
  majApercuHaut(couleursDePalette(palettePreview));
}
// Bloc d'aperçu : 3 répliques colorées (une par couleur) ; les incises gardent la couleur du texte.
function majApercuHaut(c) {
  const cols = c || couleursPaletteCourante();
  const el = $("palette-apercu-haut");
  if (el) el.innerHTML =
    '<div><span style="color:' + cols[0] + '">— Vous voyez ?</span> dit-elle.</div>' +
    '<div><span style="color:' + cols[1] + '">— Oui, tout à fait !</span> répondit Claire. <span style="color:' + cols[1] + '">C\'est stupéfiant…</span></div>' +
    '<div><span style="color:' + cols[2] + '">— Mais que faites vous ici ?</span></div>';
}
function ouvrirPalette() {
  palettePreview = etat.paletteDialogue || "aucune";
  paletteThemeApercu = etat.paletteTheme || themeActif();
  rendrePaletteListe();
  $("panneau-palette").classList.remove("cache");
}
// La palette n'est RÉELLEMENT appliquée qu'à la fermeture. Avertissement si des
// couleurs ont été attribuées manuellement aux personnages (elles seront effacées).
async function fermerPalette() {
  const diff = palettePreview && palettePreview !== etat.paletteDialogue;
  if (diff) {
    const ov = etat.couleursPersonnages || {};
    const manuel = Object.keys(ov).some((k) => k !== "_tiersMlibre");
    if (manuel && !(await confirmer("Les couleurs attribuées manuellement aux personnages seront remplacées.\n\nAppliquer la palette\n« " + palettePreview + " » ?"))) {
      $("panneau-palette").classList.add("cache"); return;   // annulé : on garde la palette actuelle
    }
    if (manuel) { etat.couleursPersonnages = {}; try { localStorage.setItem("bookreeder-perso-couleurs", "{}"); } catch (e) {} }
    const theme = (palettePreview === "perso" || palettePreview === "aucune" || palettePreview === "Accentuation +") ? "" : paletteThemeApercu;
    appliquerPaletteDialogue(palettePreview, theme);
    if (typeof renderListePersos === "function") renderListePersos();
  } else if (palettePreview === "perso") {
    appliquerPaletteDialogue("perso");   // perso retouché : ré-applique (sans toucher aux couleurs manuelles)
    if (typeof renderListePersos === "function") renderListePersos();
  }
  $("panneau-palette").classList.add("cache");
}
function naviguerThemePalette(pas) {
  const i = ORDRE_THEMES.indexOf(paletteThemeApercu);
  paletteThemeApercu = ORDRE_THEMES[(i + pas + ORDRE_THEMES.length) % ORDRE_THEMES.length];
  rendrePaletteListe();
}
document.querySelectorAll(".dd-palette-btn").forEach((b) => b.addEventListener("click", ouvrirPalette));
$("btn-fermer-palette").addEventListener("click", fermerPalette);
$("panneau-palette").addEventListener("click", (e) => { if (e.target.id === "panneau-palette") fermerPalette(); });
$("palette-theme-prec").addEventListener("click", () => naviguerThemePalette(-1));
$("palette-theme-suiv").addEventListener("click", () => naviguerThemePalette(1));
// Choix d'une palette = sélection PROVISOIRE (appliquée seulement à la fermeture).
$("palette-liste").addEventListener("click", (e) => {
  const it = e.target.closest(".palette-item");
  if (!it) return;
  palettePreview = it.dataset.nom;
  rendrePaletteListe();
});
$("palette-liste").addEventListener("pointerover", (e) => {
  const it = e.target.closest(".palette-item");
  if (it && it.dataset.couleurs) majApercuHaut(it.dataset.couleurs.split(","));
});
$("palette-liste").addEventListener("pointerleave", () => majApercuHaut(couleursDePalette(palettePreview)));
// Roues Voix 1/2/3 : modifient la palette Perso (provisoire) en direct.
["voix1-couleur", "voix2-couleur", "voix3-couleur"].forEach((id, i) => {
  $(id).addEventListener("input", (e) => {
    couleursPerso[i] = e.target.value;
    try { localStorage.setItem("bookreeder-perso-voix", JSON.stringify(couleursPerso)); } catch (err) {}
    palettePreview = "perso";
    rendrePaletteListe();
  });
});
// Pendant l'ouverture d'une roue chromatique native, ne pas assombrir l'arrière-plan
// (on rend le fond du panneau transparent le temps de la sélection). Vaut pour TOUTES
// les roues : Mes couleurs (palette), couleur d'accentuation, police, début bionic.
document.querySelectorAll('input[type="color"]').forEach((inp) => {
  const ouvrir = () => document.body.classList.add("roue-ouverte");
  const fermer = () => document.body.classList.remove("roue-ouverte");
  // pointerdown : déclenché de façon fiable sur iOS dès le tap (avant l'ouverture)
  inp.addEventListener("pointerdown", ouvrir);
  inp.addEventListener("focus", ouvrir);
  inp.addEventListener("blur", fermer);
  inp.addEventListener("change", fermer);
});
// Filet de sécurité : au retour sur la page (picker fermé), on rétablit le fond.
window.addEventListener("focus", () => document.body.classList.remove("roue-ouverte"));
// (calculerLocuteurs / zonesIncise / coefElocution : déplacés dans dialogues.js,
//  chargé à la demande. Le noyau y accède via window.MoteurDialogues.)

// Élan de reprise, piloté par le slider « Élan à la reprise » (etat.coefElan) :
//  0 = aucun élan (reprise plein régime) ; ×1 ≈ 10 mots ; ×3 ≈ 30 mots.
// Au départ l'élan est bas (elanGrossePause) puis remonte vers 1 sur (coefElan×10) mots.
function elanDepart() {
  const g = etat.modele.params.elanGrossePause || 0.65;
  return (etat.coefElan > 0) ? g : 1;
}
function elanPas() {
  const g = etat.modele.params.elanGrossePause || 0.65;
  return (etat.coefElan > 0) ? (1 - g) / (etat.coefElan * 10) : 1;
}

function delaiChunk() {
  const P = etat.modele.params;                 // recette de rythme du modèle actif
  const base = 60000 / vitesseEff();            // ms pour un mot « moyen » (avec accélération)
  const debut = etat.index, fin = etat.index + etat.nbCourant;
  const groupe = etat.mots.slice(debut, fin);

  // 1) Cadence CONSTANTE par mot : chaque mot dure `base` (= 60000/vitesse),
  //    quel que soit le groupement. Un groupe de N mots dure N×base, donc le
  //    rythme par mot ne change pas (mots isolés ou groupés = même vitesse).
  //    L'« élan » ralentit juste la reprise après une pause, puis revient à 1.
  let mot = base * etat.nbCourant / etat.elan;

  // 2) Planchers (mot lui-même) : dialogue, et majuscule en milieu de phrase
  let enDialogue = false;
  for (let k = 0; k < groupe.length; k++) {
    if (dansDialogue(debut + k)) { enDialogue = true; break; }
  }
  if (enDialogue && etat.coefPause > 0) mot = Math.max(mot, base * P.plancherDialogue);
  // « Ralentissement des dialogues » (slider) : ralentit la durée de CHAQUE mot en
  // dialogue (pas seulement les pauses), pour un effet réellement perceptible.
  if (enDialogue) mot *= etat.coefDialogue;

  // Noms propres (majuscule en milieu de phrase) : plancher par nom propre.
  const planNom = plancherNomPropre(debut, fin);
  if (planNom > 0) mot = Math.max(mot, planNom);
  const majuscule = planNom > 0;   // sert aussi à la reprise d'élan plus bas

  // Plancher GÉNÉRAL : durée mini d'un mot (× base × nb mots). À 0,6 (défaut) il
  // ne mord pas (mot = base×nb), mais permet d'imposer un minimum si on l'augmente.
  if (P.motMin) mot = Math.max(mot, base * P.motMin * etat.nbCourant);

  // 3) Respirations : ponctuation de fin de groupe OU ouverture de réplique.
  //    On ne CUMULE pas fin de phrase + entrée en dialogue (sinon pause très
  //    longue) : on garde la plus longue des deux.
  const dernier = groupe[groupe.length - 1] || "";
  let pausePonct = 0;
  if (/[.!?…]["»”'’)\]]*$/.test(dernier)) pausePonct = base * P.pauseFinPhrase;  // fin de phrase
  else if (/[,;:)\]]["»”'’]*$/.test(dernier)) pausePonct = base * P.pauseVirgule; // , ; : ) ] (fin de groupe)
  const suivant = etat.mots[fin];
  const pauseRep = (suivant && DEBUT_REPLIQUE.test(suivant)) ? base * P.pauseReplique : 0; // échanges
  // Ouverture d'une parenthèse / d'un crochet au mot suivant : petite respiration
  // (le même facteur que la virgule) — l'œil a besoin d'un instant de plus.
  const pauseParen = (suivant && /^["«“'‘\s]*[(\[]/.test(suivant)) ? base * P.pauseVirgule : 0;
  let pause = Math.max(pausePonct, pauseRep, pauseParen);
  // Respiration de fin de bloc/paragraphe (titre sans ponctuation, etc.)
  if (pause === 0 && etat.debutsPhrase && etat.debutsPhrase.has(fin)) pause += base * (P.pauseParagraphe ?? P.pauseFinPhrase);
  // Dans un dialogue, les pauses de ponctuation sont rallongées (slider, ×1,3 défaut).
  if (enDialogue) pause *= etat.coefDialogue;

  // 4) L'élan ne sert QU'À la reprise (Play, saut de phrase/chapitre) : il
  //    démarre bas à la reprise puis remonte progressivement vers 1, et ne
  //    redescend JAMAIS sur la ponctuation pendant la lecture continue.
  etat.elan = Math.min(1, etat.elan + elanPas());                       // remontée seule (vitesse selon le slider)

  // Décélération d'élocution (dialogues) : active seulement si l'effet « élocution »
  // est choisi. On applique le plus fort coefficient parmi les mots du groupe.
  if (effetDialogue("elocution")) {
    let coefElo = 1;
    const md = window.MoteurDialogues;
    if (md) for (let k = debut; k < fin; k++) coefElo = Math.max(coefElo, md.coefElocution(k));
    mot *= coefElo;
  }

  // « Ralenti sur noms propres » (option) : multiplie la durée d'affichage par 2/3/4×
  // quand le groupe contient un nom propre (majuscule hors début de phrase), pour
  // laisser le temps d'imprégner le mot — soit à CHAQUE fois, soit seulement à sa
  // 1ʳᵉ apparition (mémorisée dans etat.nomsRalentis).
  let plafond = 2000;
  if (etat.ralentiNomMult > 1) {
    let cleProp = "";
    for (let k = debut; k < fin; k++) {
      if (!estDebutPhrase(k) && commenceMajuscule(etat.mots[k])) {
        cleProp = (etat.mots[k] || "").toLowerCase().replace(/[^\p{L}]/gu, ""); break;
      }
    }
    if (cleProp) {
      if (!etat.nomsRalentis) etat.nomsRalentis = new Set();
      const dejaVu = etat.nomsRalentis.has(cleProp);
      if (etat.ralentiNomMode === "tous" || !dejaVu) { mot *= etat.ralentiNomMult; plafond = 4000; }
      etat.nomsRalentis.add(cleProp);
    }
  }

  // Le temps de pause est modulé par le coefficient réglable (0,5–4).
  // Plancher absolu : aucun mot ne s'affiche moins de ~Nms (anti-télescopage).
  // Plafond : un mot ne dépasse jamais 2 s (4 s si ralenti nom propre actif).
  return Math.min(Math.max(mot + pause * etat.coefPause, P.affichageMin), plafond);
}

// Le mot commence-t-il par une lettre MAJUSCULE (en ignorant tiret/guillemet) ?
function commenceMajuscule(mot) {
  const m = (mot || "").match(/\p{L}/u);
  return !!m && /\p{Lu}/u.test(m[0]);
}

// Durée plancher (ms) pour les noms propres (majuscule en milieu de phrase).
// Modèles concernés via params.nomPropreMs (BookReeder & Hybride).
// Chaque nom propre du groupe ajoute `nomPropreMs`, modulé par le slider « Longueur
// des pauses » (coefPause) avec 2,0× comme référence : 1,0×→250 ms, 2,0×→500 ms, 4,0×→1000 ms.
// Cumulé si plusieurs noms consécutifs (John William Woodhouse → 3×).
function plancherNomPropre(debut, fin) {
  const P = etat.modele.params;
  let n = 0;
  for (let k = debut; k < fin; k++) {
    if (!estDebutPhrase(k) && commenceMajuscule(etat.mots[k])) n++;
  }
  if (!n) return 0;
  // BookReeder : facteur × base (suit la vitesse) ; Hybride : ms absolu hérité.
  if (typeof P.nomPropreFact === "number") return n * (60000 / vitesseEff()) * P.nomPropreFact;
  if (P.nomPropreMs) return n * P.nomPropreMs * (etat.coefPause / 2);
  return 0;
}

// =========================================================
//  Modèles de lecture
//  Un modèle regroupe les règles d'AFFICHAGE : groupement des mots (chunk),
//  rythme (delai), placement du repère ORP (orp) et gras bionic (gras).
//  « BookReeder (default) » fige le comportement actuel. Pour créer un autre
//  modèle, ajouter une entrée ici avec ses propres fonctions — le défaut reste
//  intact. (La tokenisation de base `decouperEnMots` est commune à tous.)
// =========================================================
// =========================================================
//  Modèle « HotGato » (reproduction fidèle de hotgato.com)
//  - découpe : N mots, coupée sur une fin de phrase (. ! ?) ;
//  - rythme : durée = mots / vitesse, + une pause fixe si le groupe contient
//    un chiffre ou de la ponctuation (pas d'accélération douce, pas de
//    ralentissement dialogue/nom propre) ;
//  - PAS de repère ORP (le groupe est simplement centré) ;
//  - bionic : 2 premières lettres de chaque mot.
// =========================================================
function chunkHotGato(start) {
  const parts = [];
  for (let i = start; i < start + etat.nbMots && i < etat.mots.length; i++) {
    parts.push(etat.mots[i]);
    if (/[.!?]["»”'’)\]]*$/.test(etat.mots[i])) break; // coupe sur fin de phrase
  }
  return { texte: parts.join(" "), nb: parts.length || 1 };
}
function delaiHotGato() {
  const P = etat.modele.params;
  const base = 60000 / vitesseEff();
  const texte = etat.mots.slice(etat.index, etat.index + etat.nbCourant).join(" ");
  let delai = base * etat.nbCourant;
  // Noms propres (uniquement si le modèle le demande, ex. Hybride) : 500 ms mini par nom.
  const planNom = plancherNomPropre(etat.index, etat.index + etat.nbCourant);
  if (planNom > 0) delai = Math.max(delai, planNom);
  // Pause fixe dès qu'il y a un chiffre ou de la ponctuation (× coef réglable),
  // sinon respiration en fin de bloc/paragraphe (titre sans ponctuation, etc.).
  const fin = etat.index + etat.nbCourant;
  if (/[\d.,!?;:'"`«»…]/.test(texte)) delai += base * P.pauseFactor * etat.coefPause;
  else if (etat.debutsPhrase && etat.debutsPhrase.has(fin)) delai += base * P.pauseFactor * etat.coefPause;
  return Math.max(delai, P.affichageMin);
}
// Tokenisation simple façon HotGato : découpe sur les espaces (la ponctuation
// reste collée au mot, mais aucun traitement français/dialogue particulier).
function decouperHotGato(texte) {
  return (texte || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}
function orpHotGato() { return -1; } // HotGato n'a pas de repère ORP
function grasHotGato(mot) {
  const lettres = [];
  for (let k = 0; k < mot.length; k++) if (/[\p{L}\p{N}]/u.test(mot[k])) lettres.push(k);
  if (lettres.length === 0) return null;
  const nb = Math.min(2, lettres.length); // 2 premières lettres
  return { debut: lettres[0], fin: lettres[nb - 1] + 1 };
}

const MODELES = {
  default: {
    id: "default",
    nom: "BookReeder",
    // Fonctions = règles de découpe / rythme / ORP / bionic
    decouper: decouperEnMots,
    chunk: construireChunkDepuis,
    delai: delaiChunk,
    orp: calculerOrp,
    gras: bornesGras,
    // Paramètres numériques de la recette (rythme, pauses, découpe).
    // Tout est ici : pour un nouveau modèle, copier ce bloc et l'ajuster.
    params: {
      charsParMot: 5.5,        // longueur moyenne d'un mot (durée ∝ caractères)
      motMin: 0.6,             // plancher de durée d'un mot (× base × nb mots) — réglable (page 4/4)
      pauseFinPhrase: 1.5,     // pause après . ! ? … (× base) — réglable
      pauseVirgule: 1,         // pause après , ; : (× base) — réglable
      pauseParagraphe: 1.5,    // pause en fin de bloc/paragraphe sans ponctuation (× base) — réglable
      pauseReplique: 1,        // pause avant une réplique de dialogue (× base) — réglable
      plancherDialogue: 1,     // plancher de durée d'un mot en dialogue (× base) — réglable
      nomPropreFact: 2.5,      // plancher par nom propre (× base ; 2,5 ≈ 500 ms à 300 mots/min) — réglable
      elanGrossePause: 0.65,   // élan de départ à la reprise (Play / saut) — réglable
      elanPauseMoyenne: 0.82,  // (inutilisé : l'élan ne sert plus qu'à la reprise)
      elanAccel: 0.0233,       // +0,0233/mot : reprise étalée sur ~15 mots (0,65 → 1)
      affichageMin: 90,        // durée mini absolue d'affichage (ms)
      motLongMax: 12,          // au-delà, un mot s'affiche seul
      lettresMax: 16,          // un groupe ne dépasse jamais ce nb de lettres
    },
  },
  hotgato: {
    id: "hotgato",
    nom: "HotGato",
    decouper: decouperHotGato,
    chunk: chunkHotGato,
    delai: delaiHotGato,
    orp: orpHotGato,
    gras: grasHotGato,
    params: {
      pauseFactor: 3,   // pause fixe (× base × coef) sur ponctuation/chiffre
      affichageMin: 90, // durée mini d'affichage (ms)
    },
  },
  // Hybride : découpe + ORP + bionic de BookReeder, mais RYTHME de HotGato
  // (cadence régulière + pause fixe sur ponctuation, sans élan ni planchers).
  hybride: {
    id: "hybride",
    nom: "Hybride",
    decouper: decouperEnMots,
    chunk: construireChunkDepuis,
    delai: delaiHotGato,
    orp: calculerOrp,
    gras: bornesGras,
    params: {
      pauseFactor: 3,   // pause fixe (× base × coef) sur ponctuation/chiffre
      affichageMin: 90,
      motLongMax: 12,   // utilisés par construireChunkDepuis (découpe BookReeder)
      lettresMax: 16,
      nomPropreMs: 500,       // 500 ms mini par nom propre @2,0× (cumulés si consécutifs)
    },
  },
};

function activerModele(id) {
  etat.modele = MODELES[id] || MODELES.default;
  etat.modeleId = etat.modele.id;
  try { localStorage.setItem("bookreeder-modele", etat.modeleId); } catch (e) {}
}

function initialiserModeles() {
  let id = "default";
  try { id = localStorage.getItem("bookreeder-modele") || "default"; } catch (e) {}
  activerModele(id);
  // Remplit le menu déroulant des réglages
  const sel = $("reglage-modele");
  if (sel) {
    sel.innerHTML = "";
    Object.values(MODELES).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.nom;
      sel.appendChild(opt);
    });
    sel.value = etat.modeleId;
  }
}

function tick() {
  if (!etat.enLecture) return;   // garde-fou : pas de minuteur résiduel (anti-chevauchement)
  if (etat.index >= etat.mots.length) {
    pause();
    return;
  }
  afficherChunk();           // calcule etat.nbCourant
  // Si le mode loupe est ouvert : surligne le mot courant et recentre sa ligne
  // (défilement auto seulement au changement de ligne).
  if (!$("ecran-contexte").classList.contains("cache")) rafraichirContexte(true);
  const d = etat.modele.delai();
  // Fondu du mot : 0 → 100 % sur 80 % de sa durée d'affichage (d),
  // puis 100 % pendant les 20 % restants (facteur 0,8).
  if (etat._enDialFondu) {
    motAffiche.style.setProperty("--fondu-duree", (d * 0.8) + "ms");
    void motAffiche.offsetWidth;            // redémarre l'animation
    motAffiche.classList.add("dlg-fondu");
  }
  const finChap = bornesChapitre().fin;     // fin du chapitre du chunk affiché
  const mode = etat.pauseAuto;              // "fin" | "suivant" | "off"

  // Mode « Chapitre suivant » : on vient d'afficher le 1er chunk du nouveau
  // chapitre → on le laisse à l'écran puis on met en pause.
  if (mode === "suivant" && etat._pauseApresChunk) {
    etat._pauseApresChunk = false;
    etat.index += etat.nbCourant;
    etat.minuteur = setTimeout(pause, d);
    return;
  }

  etat.index += etat.nbCourant;
  // On vient de finir un chapitre et il en reste un autre.
  if (mode !== "off" && finChap < etat.mots.length && etat.index >= finChap) {
    etat.index = finChap;                   // prêt à reprendre au chapitre suivant
    etat.elan = elanDepart();   // élan appliqué dès le 1er mot du chapitre suivant
    if (mode === "fin") {
      etat.minuteur = setTimeout(pause, d); // pause en montrant la fin du chapitre
    } else {                                // "suivant" : enchaîner pour montrer le 1er chunk du suivant
      etat._pauseApresChunk = true;
      etat.minuteur = setTimeout(tick, d);
    }
    return;
  }
  etat.minuteur = setTimeout(tick, d);
}

function lecture() {
  if (etat.enLecture) return;
  if (etat.index >= etat.mots.length) etat.index = 0;
  etat.enLecture = true;
  etat.elan = elanDepart();   // reprise en douceur (remonte vers 1)
  etat.multAccel = 1;       // l'accélération repart de la vitesse initiale
  majVitesseAffichee();
  demarrerAccel();          // (re)lance la rampe toutes les 10 s si coef > 1
  etat._pauseApresChunk = false;
  clearTimeout(etat.minuteur); // évite tout minuteur en double
  iconeLecture(true);
  majDureeChapitre();
  // Rafraîchit l'estimation chaque minute réelle de lecture
  clearInterval(etat.minuteurDuree);
  etat.minuteurDuree = setInterval(majDureeChapitre, 60000);
  activerVeille();          // garde l'écran allumé pendant la lecture
  { const n = $("note-min"); if (n) n.classList.add("cache"); }  // annotation minimaliste masquée en lecture
  tick();
}

// --- Empêcher l'écran de s'éteindre pendant la lecture (Wake Lock) ---
let verrouEcran = null;
async function activerVeille() {
  try {
    if (navigator.wakeLock && !verrouEcran) {
      verrouEcran = await navigator.wakeLock.request("screen");
      verrouEcran.addEventListener("release", () => { verrouEcran = null; });
    }
  } catch (e) { /* non supporté ou refusé : on ignore */ }
}
async function libererVeille() {
  try { if (verrouEcran) { await verrouEcran.release(); verrouEcran = null; } } catch (e) {}
}
// Le verrou saute quand l'app passe en arrière-plan : on le reprend au retour si on lit.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && etat.enLecture) activerVeille();
});

// Bascule l'icône des boutons play/pause (normal + épuré) :
// true = en lecture (barres pause), false = play (triangle)
function iconeLecture(joue) {
  // Lecture auto EN loupe : la phrase s'atténue comme le reste, seul le mot lu est blanc.
  const ctx = $("ecran-contexte");
  if (ctx) ctx.classList.toggle("lecture-auto", joue && !ctx.classList.contains("cache"));
  ["btn-lecture", "ep-lecture", "ctx-play"].forEach((id) => {
    const b = $(id);
    if (!b) return;
    b.classList.toggle("icone-pause", joue);
    b.classList.toggle("icone-play", !joue);
  });
}

function pause() {
  etat.enLecture = false;
  clearTimeout(etat.minuteur);
  clearInterval(etat.minuteurDuree);
  libererVeille();          // l'écran peut de nouveau s'éteindre
  clearInterval(etat.minuteurAccel);
  etat.multAccel = 1;       // toute pause réinitialise l'accélération
  majVitesseAffichee();
  iconeLecture(false);
  majDureeChapitre();
  sauverPosition();
  if (typeof majAnnotationMinimal === "function") majAnnotationMinimal();  // note visible à la pause (Minimaliste)
}

function basculerLecture() {
  etat.enLecture ? pause() : lecture();
}

// Estimation (approchée) du temps pour lire la plage [debut, fin) : durée de
// base par mot + plancher des noms propres + pauses de ponctuation (× coef de
// pause, ×1,5 en dialogue). On NE tient PAS compte de l'élan de reprise.
const RE_FIN_PH = /[.!?…]["»”'’)\]]*$/;
const RE_VIRG_PH = /[,;:)\]]["»”'’]*$/;
function dureeEstimeeMs(debut, fin) {
  const base = 60000 / Math.max(1, etat.vitesse);   // ms par mot (vitesse réglée)
  const P = etat.modele.params;
  const coef = etat.coefPause;
  // Rythme « HotGato » (modèles HotGato & Hybride) : pas de pauseFinPhrase/
  // pauseVirgule dans leurs params, mais une pause fixe ×pauseFactor sur la
  // ponctuation/chiffre. Sans ce branchement, base×undefined = NaN (durée cassée).
  const rythmeHotgato = typeof P.pauseFactor === "number";
  let total = 0;
  for (let i = debut; i < fin; i++) {
    const w = etat.mots[i] || "";
    let mot = base;
    if (!estDebutPhrase(i) && commenceMajuscule(w)) {                       // plancher nom propre
      if (typeof P.nomPropreFact === "number") mot = Math.max(mot, base * P.nomPropreFact);
      else if (P.nomPropreMs) mot = Math.max(mot, P.nomPropreMs * coef / 2);
    }
    if (P.motMin) mot = Math.max(mot, base * P.motMin);                     // plancher général
    let pause = 0;
    if (rythmeHotgato) {
      // pause fixe dès qu'il y a un chiffre/ponctuation, sinon fin de bloc (cf. delaiHotGato)
      if (/[\d.,!?;:'"`«»…]/.test(w) || (etat.debutsPhrase && etat.debutsPhrase.has(i + 1)))
        pause = base * P.pauseFactor;
    } else {
      if (RE_FIN_PH.test(w)) pause = base * P.pauseFinPhrase;
      else if (RE_VIRG_PH.test(w)) pause = base * P.pauseVirgule;
      if (dansDialogue(i)) pause *= etat.coefDialogue; // pauses rallongées en dialogue
    }
    total += mot + pause * coef;
  }
  return total;
}
// Durée estimée pour finir le chapitre courant (mots RESTANTS), en tenant compte
// des pauses/coefs. Recalculée à chaque play/pause/saut.
function majDureeChapitre() {
  const el = $("duree-chapitre");
  if (!el || !etat.mots.length) return;
  const { fin } = bornesChapitre();
  const totalMin = dureeEstimeeMs(etat.index, fin) / 60000;   // ms → minutes
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  // Sous 1 h, on n'affiche que les minutes ; au-delà, format XhYY.
  let txt;
  if (h > 0) txt = `${h}h${String(m).padStart(2, "0")}`;
  else if (totalMin < 1) txt = "< 1 min";   // moins d'une minute
  else if (totalMin < 2) txt = "> 1 min";   // entre 1 et 2 min (estimation trop imprécise)
  else txt = `${m} min`;
  el.textContent = `Durée du chapitre : ${txt}`;
}

// =========================================================
//  Navigation et progression
// =========================================================
// Déplace la lecture de `pas` mots. Si `continuer` et que l'option est
// active et qu'on lisait, la lecture reprend immédiatement (fluidité) ;
// sinon on se met en pause à la nouvelle position.
function deplacer(pas, continuer) {
  const reprendre = continuer && etat.continuerApresSaut && etat.enLecture;
  clearTimeout(etat.minuteur);
  etat.elan = elanDepart();   // saut : reprise en douceur
  etat.index = Math.min(Math.max(0, etat.index + pas), etat.mots.length - 1);
  afficherChunk();
  majDureeChapitre();        // recalcule la durée restante après le saut
  if (reprendre) {
    // Reprise différée (réarmée à chaque saut) pour permettre d'enchaîner
    etat.minuteur = setTimeout(tick, DELAI_REPRISE);
  } else {
    etat.enLecture = false;
    iconeLecture(false);
  }
  sauverPosition();
}

// --- Navigation par phrase ---
// Un mot commence une phrase si le mot précédent terminait la précédente.
function estDebutPhrase(i) {
  if (i <= 0) return true;
  if (etat.debutsPhrase && etat.debutsPhrase.has(i)) return true;  // début de bloc/paragraphe
  const prec = etat.mots[i - 1] || "";
  // Le point d'un titre (M., Mme…) n'est pas une fin de phrase.
  return FIN_PHRASE.test(prec) && !estHonorifique(prec);
}
// Début de la phrase contenant (ou précédant) l'index i
function debutPhraseAvant(i) {
  let j = Math.min(Math.max(0, i), etat.mots.length - 1);
  while (j > 0 && !estDebutPhrase(j)) j--;
  return j;
}
// Cible du bouton « retour » : début de la phrase en cours, ou de la
// précédente si on est déjà au tout début de la phrase courante.
function phrasePrecedente() {
  const debut = debutPhraseAvant(etat.index);
  if (debut < etat.index) return debut;
  return debutPhraseAvant(etat.index - 1);
}
// Cible du bouton « avance » : début de la phrase suivante.
function phraseSuivante() {
  let j = etat.index + 1;
  while (j < etat.mots.length && !estDebutPhrase(j)) j++;
  return Math.min(j, etat.mots.length - 1);
}

// Y a-t-il un vrai découpage en chapitres ? (sinon : saut de 1000 mots)
function chapitragePresent() {
  return etat.chapitres.length > 1;
}

// Saute au chapitre voisin (dir = -1 précédent, +1 suivant), toujours au
// DÉBUT du chapitre. « Précédent » revient d'abord au début du chapitre
// courant si on y est déjà engagé. Sans chapitrage : saut de 1000 mots.
function allerChapitre(dir) {
  if (!chapitragePresent()) { deplacer(dir * 1000, true); return; }
  const ci = etat.chapitres.indexOf(chapitreActuel());
  let cible = ci + dir;
  if (dir < 0 && etat.index > chapitreActuel().debut + 3) cible = ci;
  cible = Math.min(Math.max(0, cible), etat.chapitres.length - 1);
  deplacer(etat.chapitres[cible].debut - etat.index, true);
}

// Bornes [debut, fin) du chapitre courant
function bornesChapitre() {
  const ci = etat.chapitres.indexOf(chapitreActuel());
  const debut = etat.chapitres[ci] ? etat.chapitres[ci].debut : 0;
  const fin = (ci >= 0 && ci + 1 < etat.chapitres.length)
    ? etat.chapitres[ci + 1].debut : etat.mots.length;
  return { ci, debut, fin };
}

function majProgression() {
  // Écran principal = tout est relatif au CHAPITRE courant
  // (la position dans le livre entier est dans le panneau de navigation).
  const { debut, fin } = bornesChapitre();
  const lenChap = Math.max(1, fin - debut);
  const posChap = Math.min(lenChap, Math.max(0, etat.index - debut));
  const pctChap = (posChap / lenChap) * 100;
  $("progression-remplissage").style.width = pctChap + "%";
  $("curseur").style.left = pctChap + "%";
  $("position-actuelle").textContent = posChap;
  $("total-mots").textContent = lenChap;
  $("position-pct").textContent = pctChap.toFixed(1).replace(".", ",");
  $("chapitre-actuel").textContent = tronquerTitre(chapitreActuel().titre);

  // Infos de lecture du Mode Minimaliste (sous les boutons de vitesse)
  const im = $("infos-minimal");
  if (im) {
    // En Minimaliste HORIZONTAL uniquement : « • X min restant » en fin de ligne.
    const horizontal = ecranLecture.classList.contains("epure") && mqPaysage.matches;
    im.innerHTML = infosLectureHtml(true, horizontal ? dureeRestanteCourt() : "");
  }

  if (!$("panneau-navigation").classList.contains("cache")) majBarreLivre();
}

// Ligne d'infos de lecture (position % · chapitre [· nb de mots]), partagée par
// le Mode Minimaliste et le Mode Loupe.
function infosLectureHtml(avecMots, restant) {
  const { debut, fin } = bornesChapitre();
  const lenChap = Math.max(1, fin - debut);
  const posChap = Math.min(lenChap, Math.max(0, etat.index - debut));
  const pctChap = (posChap / lenChap) * 100;
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = pctChap.toFixed(1).replace(".", ",") + " % • " + esc(tronquerTitre(chapitreActuel().titre));
  if (restant) html += " • " + restant;                                                     // durée restante (même séparateur que le titre)
  if (avecMots && etat.afficherMots) html += "<br>" + posChap + " / " + lenChap + " mots";  // 2e ligne
  return html;
}
// Durée de lecture restante du chapitre courant, formatée court (« X min restant »).
function dureeRestanteCourt() {
  const { fin } = bornesChapitre();
  const totalMin = dureeEstimeeMs(etat.index, fin) / 60000;
  const h = Math.floor(totalMin / 60), m = Math.round(totalMin % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")} restant`;
  if (totalMin < 1) return "< 1 min restant";
  return `${Math.max(1, m)} min restant`;
}

// Barre du livre entier (panneau de navigation)
function majBarreLivre() {
  const pct = etat.mots.length ? (etat.index / etat.mots.length) * 100 : 0;
  $("remplissage-livre").style.width = pct + "%";
  $("curseur-livre").style.left = pct + "%";
  $("position-pct-livre").textContent = pct.toFixed(1).replace(".", ",");
  // Le menu déroulant suit automatiquement le chapitre courant
  const sel = $("nav-chapitre");
  if (sel.options.length) sel.value = etat.chapitres.indexOf(chapitreActuel());
}

// Tronque un titre de chapitre trop long pour la ligne d'info
function tronquerTitre(t) {
  t = t || "";
  return t.length > 28 ? t.slice(0, 28).trimEnd() + "..." : t;
}

// Chapitre contenant la position de lecture courante
function chapitreActuel() {
  let courant = etat.chapitres[0] || { titre: "—", debut: 0 };
  for (const ch of etat.chapitres) {
    if (ch.debut <= etat.index) courant = ch; else break;
  }
  return courant;
}

// Remplit le menu déroulant des chapitres
// --- Table des matières : mode « existante » (nettoyée) ou « optimisée » ---
// Construit etat.chapitres depuis la TOC brute (etat.chapitresBrut) selon le mode.
function appliquerModeTOC() {
  const mode = etat.tocMode || "existante";
  const brut = etat.chapitresBrut || etat.chapitres || [];
  etat.chapitres = (window.Chargeur ? window.Chargeur.construireTOC(brut, mode) : brut.slice());
  if (!etat.chapitres || !etat.chapitres.length) etat.chapitres = [{ titre: "Début", debut: 0 }];
}
// Détermine le mode au chargement : choix mémorisé du livre, sinon « optimisée »
// quand il n'y a pas de vraie TOC, sinon on prévoit de demander à l'utilisateur.
function initModeTOC() {
  const reelle = !!(window.Chargeur && window.Chargeur.aTOCReelle(etat.chapitresBrut));
  etat.tocReelle = reelle;
  let mode = null;
  if (etat.idLivre) { try { mode = localStorage.getItem("bookreeder-toc-" + etat.idLivre); } catch (e) {} }
  etat.tocADemander = reelle && !mode && !!etat.idLivre;   // 1ʳᵉ ouverture d'un vrai fichier à TOC
  etat.tocMode = mode || (reelle ? "existante" : "optimisee");
  appliquerModeTOC();
}
// Applique un choix de table et le mémorise pour ce livre.
function choisirModeTOC(mode) {
  etat.tocMode = mode;
  etat.tocADemander = false;
  if (etat.idLivre) { try { localStorage.setItem("bookreeder-toc-" + etat.idLivre, mode); } catch (e) {} }
  appliquerModeTOC();
  remplirSelectChapitres();
  placerMarqueursChapitres();
  const p = $("panneau-toc"); if (p) p.classList.add("cache");
}
// Ouvre le popup de choix de table (1ʳᵉ ouverture, ou « Reconstruire »), avec un
// aperçu des premiers titres de chaque version pour comparer avant de choisir.
function listeTOC(mode) {
  const brut = etat.chapitresBrut || etat.chapitres || [];
  return (window.Chargeur ? window.Chargeur.construireTOC(brut, mode) : brut) || [];
}
function apercuTOC(liste) {
  if (!liste.length) return ["(aucun chapitre)"];
  // Titre sur une seule ligne : coupé après 20 lettres avec « … ».
  const court = (s) => { s = (s || "—").trim(); return s.length > 20 ? s.slice(0, 20).trimEnd() + "…" : s; };
  const t = liste.map((c) => court(c.titre));
  if (t.length <= 10) return t;
  // Trop long : 6 premiers + « [ … ] » + 3 derniers.
  return t.slice(0, 6).concat("[ … ]", t.slice(-3));
}
// Remplit un aperçu : un titre par ligne, jamais sur 2 lignes (coupe « … »).
function remplirApercu(el, liste) {
  if (!el) return;
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  el.innerHTML = apercuTOC(liste).map((l) => '<div class="toc-l">' + esc(l) + "</div>").join("");
}
function ouvrirChoixTOC() {
  const exi = listeTOC("existante"), opt = listeTOC("optimisee");
  const ce = $("toc-cnt-existante"); if (ce) ce.textContent = "(" + exi.length + " chapitres)";
  const co = $("toc-cnt-optimisee"); if (co) co.textContent = "(" + opt.length + " chapitres)";
  remplirApercu($("toc-apercu-existante"), exi);
  remplirApercu($("toc-apercu-optimisee"), opt);
  const p = $("panneau-toc"); if (p) p.classList.remove("cache");
}
function remplirSelectChapitres() {
  const sel = $("nav-chapitre");
  sel.innerHTML = "";
  etat.chapitres.forEach((ch, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = ch.titre;
    sel.appendChild(opt);
  });
}

// Place un repère de chapitre sur la barre du LIVRE ENTIER (panneau nav).
// La barre principale ne représente que le chapitre courant : pas de repères.
function placerMarqueursChapitres() {
  $("marqueurs-chapitres").innerHTML = "";
  const conteneur = $("marqueurs-livre");
  if (!conteneur) return;
  conteneur.innerHTML = "";
  if (!etat.mots.length) return;
  etat.chapitres.forEach((ch) => {
    if (ch.debut === 0) return;
    const trait = document.createElement("div");
    trait.className = "marqueur";
    trait.style.left = (ch.debut / etat.mots.length) * 100 + "%";
    conteneur.appendChild(trait);
  });
}

function demarrerLecture() {
  ecranAccueil.classList.add("cache");
  ecranLecture.classList.remove("cache");
  if (typeof rafraichirBulleLireMoi === "function") rafraichirBulleLireMoi();
  $("titre-livre").textContent = etat.titreLivre || etat.nomLivre || "";
  reglerVitesse(etat.vitesse, true);   // simple rafraîchissement (ne pas écrire dans le profil)
  ajusterCadre();
  appliquerOrp();
  afficherChunk();
  majDureeChapitre();
  if (typeof gererOrientation === "function") gererOrientation(); // paysage → minimaliste
  if (etat.tocADemander) ouvrirChoixTOC();   // 1ʳᵉ ouverture : quelle table de matières ?
}

// =========================================================
//  Contrôles UI
// =========================================================
// --- Mode loupe : tout le chapitre, scrollable ; clic = point de reprise ---
let ctxRange = null;                          // bornes de mots rendues {a, b}
let ctxSpans = new Map();                      // index du mot -> <span> (évite les querySelector répétés)
function construireContexte() {
  const cont = $("contexte-texte");
  const { debut, fin } = bornesChapitre();
  ctxRange = { a: debut, b: fin };
  const echap = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Index de début de chapitre (le 1er bloc du chapitre = son titre → en Black).
  const debutsChap = new Set(etat.chapitres.map((c) => c.debut));
  const notesMot = etat.noteParMot || new Map();
  // Longueur (en mots) de chaque bloc, pour ne mettre en gras (ctx-titre) que les
  // VRAIS titres courts — pas un long 1er paragraphe qui commence un chapitre.
  const finBloc = (i) => { let j = i + 1; while (j < fin && !(etat.debutsPhrase && etat.debutsPhrase.has(j))) j++; return j; };
  let html = "", ouvert = false;
  for (let i = debut; i < fin; i++) {
    if (i === debut || (etat.debutsPhrase && etat.debutsPhrase.has(i))) {  // nouveau bloc/paragraphe
      if (ouvert) html += "</p>";
      const estTitre = debutsChap.has(i) && (finBloc(i) - i) <= 8;   // titre = début de chapitre ET court
      html += `<p class="ctx-bloc${estTitre ? " ctx-titre" : ""}">`;
      ouvert = true;
    }
    const ns = notesMot.get(i);
    const sup = (ns && ns.length)
      ? `<sup class="ctx-note">${echap(ns.map((n) => n.num).join(","))}</sup>` : "";
    // Couleur du locuteur (multicolore) si l'effet est actif et le mot est dans un dialogue.
    const coul = (effetDialogue("multicolore") && etat.couleurParMot) ? etat.couleurParMot.get(i) : "";
    const cls = (ns && ns.length ? "a-note" : "") + (coul ? " ctx-dlg" : "");
    const styleCoul = coul ? ` style="--c-dlg:${coul}"` : "";
    // L'exposant est COLLÉ au mot : on l'insère AVANT la ponctuation fermante
    // (guillemet, parenthèse, crochet) si le mot en a une.
    let motHtml = echap(etat.mots[i]);
    if (sup) {
      const m = motHtml.match(/([^\p{L}\p{N}]+)$/u);   // ponctuation de fin (» . ) … )
      if (m) motHtml = motHtml.slice(0, motHtml.length - m[1].length) + sup + m[1];
      else motHtml += sup;
    }
    html += `<span data-i="${i}"${cls ? ` class="${cls.trim()}"` : ""}${styleCoul}>${motHtml}</span> `;
  }
  if (ouvert) html += "</p>";
  cont.innerHTML = html;
  // Mémorise les spans une seule fois (lookup direct au surlignage).
  ctxSpans = new Map();
  cont.querySelectorAll("span[data-i]").forEach((s) => ctxSpans.set(+s.dataset.i, s));
}
function marquerCourant(recentrer) {
  const cont = $("contexte-texte");
  cont.querySelectorAll(".courant, .phrase-courante").forEach((s) => s.classList.remove("courant", "phrase-courante"));
  const nb = Math.max(1, (etat.modele.chunk(etat.index) || {}).nb || 1);
  // Phrase entière contenant le mot courant : du début de phrase au début suivant.
  const phDebut = debutPhraseAvant(etat.index);
  let phFin = etat.index + 1;
  while (phFin < etat.mots.length && !estDebutPhrase(phFin)) phFin++;
  for (let i = phDebut; i < phFin; i++) {
    const s = ctxSpans.get(i);
    if (s) s.classList.add("phrase-courante");   // phrase en cours (100 % d'opacité)
  }
  // Mot/groupe en cours : couleur accentuée (repère).
  let prem = null;
  for (let i = etat.index; i < etat.index + nb; i++) {
    const s = ctxSpans.get(i);
    if (s) { s.classList.add("courant"); if (!prem) prem = s; }
  }
  if (recentrer && prem && !etat.loupeSansScroll) prem.scrollIntoView({ block: "center" });
  const ci = $("contexte-infos");
  if (ci) ci.innerHTML = infosLectureHtml();
}
function rafraichirContexte(recentrer) {
  if (!ctxRange || etat.index < ctxRange.a || etat.index >= ctxRange.b) construireContexte();
  marquerCourant(recentrer);
}
function ouvrirContexte() {
  if (!etat.mots.length) return;
  if (etat.enLecture) pause();
  $("ecran-contexte").classList.remove("cache");
  construireContexte();
  marquerCourant(true);
}
function fermerContexte() { if (typeof fermerBulleNote === "function") fermerBulleNote(); $("ecran-contexte").classList.remove("lecture-auto"); $("ecran-contexte").classList.add("cache"); }
// Déplace dans la loupe puis, si on lisait, reprend la lecture après 1 s de
// pause — réarmée à chaque saut (non cumulable), comme en lecture rapide.
function allerLoupe(cible) {
  fermerBulleNote();
  clearTimeout(etat.minuteur);
  etat.index = Math.min(Math.max(0, cible), etat.mots.length - 1);
  etat.elan = elanDepart();   // saut : reprise en douceur
  rafraichirContexte(true);
  if (etat.enLecture) etat.minuteur = setTimeout(tick, 1000);   // 1 s avant reprise
}
// Index cible du chapitre voisin (même logique qu'allerChapitre).
function cibleChapitreLoupe(dir) {
  if (!chapitragePresent()) return etat.index + dir * 1000;
  const ci = etat.chapitres.indexOf(chapitreActuel());
  let cible = ci + dir;
  if (dir < 0 && etat.index > chapitreActuel().debut + 3) cible = ci;
  cible = Math.min(Math.max(0, cible), etat.chapitres.length - 1);
  return etat.chapitres[cible].debut;
}
// Flèches loupe : clic court = phrase préc./suiv. ; appui long (≈0,5 s) = chapitre.
function installerFlecheLoupe(id, court, longg) {
  const btn = $(id);
  if (!btn) return;
  let timer = null, long = false;
  btn.addEventListener("pointerdown", () => { long = false; timer = setTimeout(() => { long = true; longg(); }, 500); });
  ["pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
  btn.addEventListener("pointerup", () => clearTimeout(timer));
  btn.addEventListener("click", () => { if (long) { long = false; return; } court(); });
}
installerFlecheLoupe("ctx-recul",
  () => allerLoupe(phrasePrecedente()),
  () => allerLoupe(cibleChapitreLoupe(-1)));
installerFlecheLoupe("ctx-avance",
  () => allerLoupe(phraseSuivante()),
  () => allerLoupe(cibleChapitreLoupe(1)));
// Trouve le mot le plus proche d'un point (x, y) — pour ne pas avoir à viser
// précisément : on privilégie un mot sur la même ligne, sinon le plus proche.
function spanProche(cont, x, y) {
  const spans = cont.querySelectorAll("span[data-i]");
  let surLigne = null, distLigne = Infinity, partout = null, distPartout = Infinity;
  for (const s of spans) {
    const r = s.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // même ligne = le point est dans la hauteur de la ligne du mot
    if (y >= r.top && y <= r.bottom) {
      const d = Math.abs(x - cx);
      if (d < distLigne) { distLigne = d; surLigne = s; }
    }
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d2 < distPartout) { distPartout = d2; partout = s; }
  }
  return surLigne || partout;
}
// Bulle d'annotation : ouverte au clic sur un mot porteur de note (ou son
// exposant). Affiche le texte de la/des note(s), recadrée dans l'écran.
function echHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fermerBulleNote() { const b = $("bulle-note"); if (b) b.classList.add("cache"); }
function ouvrirBulleNote(i, ancre) {
  const notes = (etat.noteParMot && etat.noteParMot.get(i)) || [];
  if (!notes.length) return;
  let b = $("bulle-note");
  if (!b) {
    b = document.createElement("div");
    b.id = "bulle-note"; b.className = "cache";
    $("ecran-contexte").appendChild(b);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fermerBulleNote(); });
  }
  b.innerHTML = notes.map((n) =>
    `<p><b>${echHtml(n.num)}.</b> ${n.texte ? echHtml(n.texte) : "<i>(annotation introuvable)</i>"}</p>`
  ).join("");
  b.classList.remove("cache");
  // Positionnement sous l'ancre, recadré dans la fenêtre (largeur fixée en CSS).
  const r = ancre.getBoundingClientRect();
  const bb = b.getBoundingClientRect();
  let left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - bb.width));
  let top = r.bottom + 8;
  if (top + bb.height > window.innerHeight - 8) top = Math.max(8, r.top - 8 - bb.height);
  b.style.left = left + "px";
  b.style.top = top + "px";
}
// Action d'un appui SIMPLE en loupe : mot porteur de note → bulle d'annotation ;
// sinon on repositionne la lecture au début de la phrase cliquée.
function actionSimpleLoupe(i, s) {
  fermerBulleNote();
  if (etat.noteParMot && etat.noteParMot.has(i)) { ouvrirBulleNote(i, s); return; }
  etat.index = debutPhraseAvant(i);
  marquerCourant(false);
  sauverPosition();
}
// Clic/appui sur le texte en loupe : repositionne la lecture (ou ouvre la note).
// On ignore le clic s'il vient d'une sélection de texte (copier / recherche Web).
$("contexte-texte").addEventListener("click", (e) => {
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && (sel.toString() || "").trim()) return;
  let s = e.target.closest("span[data-i]");
  if (!s) s = spanProche($("contexte-texte"), e.clientX, e.clientY);
  if (!s) return;
  actionSimpleLoupe(+s.dataset.i, s);
});

// --- Recherche dans tout le livre (bulle au-dessus des boutons, en mode loupe) ---
// Élision française de tête (l', d', qu', j', t', s', n', m', c'…), apostrophe
// droite ou typographique — à retirer pour que « d'anguille » trouve « anguille ».
const ELISION = /^(qu|[ldjtnmcs])['’]/i;
function sansElision(s) {
  return (s || "").replace(/ /g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")   // ponctuation de tête
    .replace(ELISION, "");             // élision
}
function normaliserMot(s) {
  return sansElision(s).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
// Cœur visible d'un jeton (sans espaces insécables ni ponctuation de bord)
function coeurMot(s) {
  return (s || "").replace(/ /g, " ").trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(ELISION, "");
}
function chapitrePourIndex(j) {
  let c = etat.chapitres[0] || { titre: "" };
  for (const ch of etat.chapitres) { if (ch.debut <= j) c = ch; else break; }
  return c;
}
function extraitAutour(j) {
  const a = Math.max(0, j - 6), b = Math.min(etat.mots.length, j + 7);
  let html = "";
  for (let k = a; k < b; k++) {
    const mot = echHtml(etat.mots[k].replace(/ /g, " "));
    html += (k === j ? "<b>" + mot + "</b>" : mot) + " ";
  }
  return html.trim();
}
const MAX_RESULTATS = 300;
// Normalise une saisie libre (accents/casse/ponctuation) en suite de mots.
function normaliserTexte(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
// Lance la recherche de la saisie courante et affiche la liste des occurrences.
function lancerRecherche() {
  const cont = $("rech-resultats");
  const req = normaliserTexte($("rech-champ").value);
  if (req.length < 2) {
    cont.innerHTML = '<p class="res-vide">Saisissez au moins 2 caracteres.</p>';
    return;
  }
  const motsReq = req.split(" ").filter(Boolean);
  const trouves = [];
  for (let j = 0; j + motsReq.length <= etat.mots.length && trouves.length < MAX_RESULTATS; j++) {
    let ok = true;
    for (let k = 0; k < motsReq.length; k++) {
      if (!normaliserMot(etat.mots[j + k]).includes(motsReq[k])) { ok = false; break; }
    }
    if (ok) trouves.push(j);
  }
  if (trouves.length === 0) {
    cont.innerHTML = '<p class="res-vide">Aucune occurrence trouvee.</p>';
    return;
  }
  const entete = '<p class="res-compte">' + trouves.length +
    (trouves.length >= MAX_RESULTATS ? "+" : "") +
    " occurrence" + (trouves.length > 1 ? "s" : "") + "</p>";
  cont.innerHTML = entete + trouves.map((j) =>
    '<button class="res-item" data-i="' + j + '">' +
    '<span class="res-chap">' + echHtml(tronquerTitre(chapitrePourIndex(j).titre)) + '</span>' +
    extraitAutour(j) + '</button>'
  ).join("");
  cont.scrollTop = 0;
}
function ouvrirRecherche() {
  fermerBulleNote();
  $("rech-champ").value = "";
  $("rech-resultats").innerHTML = "";
  $("panneau-recherche").classList.remove("cache");
  $("rech-champ").focus();
}
function fermerRecherche() { $("panneau-recherche").classList.add("cache"); }
$("rech-go").addEventListener("click", lancerRecherche);
$("rech-champ").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); lancerRecherche(); }
  else if (e.key === "Escape") { e.preventDefault(); fermerRecherche(); }
});
$("rech-resultats").addEventListener("click", (e) => {
  const it = e.target.closest(".res-item");
  if (!it) return;
  etat.index = Math.min(Math.max(0, +it.dataset.i), etat.mots.length - 1);
  fermerRecherche();
  rafraichirContexte(true);   // saute à l'occurrence (reconstruit si besoin + recentre)
  sauverPosition();
});
$("panneau-recherche").addEventListener("click", (e) => {
  if (e.target.id === "panneau-recherche") fermerRecherche();  // clic sur le fond
});
// Bouton Play de la loupe :
//  - CLIC COURT = ferme la loupe et REPREND la lecture rapide (après 0,5 s) ;
//  - APPUI PROLONGÉ (≈0,5 s) = ferme la loupe SANS relancer la lecture.
function fermerLoupe(relancer) {
  fermerBulleNote();
  fermerContexte();
  afficherChunk();
  if (relancer) { clearTimeout(etat.minuteur); etat.minuteur = setTimeout(lecture, 500); }
}
(function installerCtxPlay() {
  const btn = $("ctx-play");
  if (!btn) return;
  let timer = null, long = false;
  // Appui long (≈0,5 s) : lance / met en pause la lecture DANS le mode loupe
  // (mot courant centré, défilement auto). Appui simple : ferme la loupe et
  // reprend la lecture rapide.
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(() => { long = true; basculerLecture(); }, 500);
  });
  ["pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
  btn.addEventListener("pointerup", () => clearTimeout(timer));
  btn.addEventListener("click", () => {
    if (long) { long = false; return; }   // c'était un appui long → lecture dans la loupe
    fermerLoupe(!etat.pauseLoupe);         // appui simple → ferme ; reprend la lecture sauf si « Pause à la sortie »
  });
})();
// Petite info-bulle au centre de l'écran (~1 s) pour signaler une bascule.
let _toastTimer = null;
function toastLoupe(msg) {
  const t = $("loupe-toast"); if (!t) return;
  t.textContent = msg; t.classList.remove("cache");
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => t.classList.add("cache"), 1000);
}
// Infobulle 1 s centrée sur l'écran principal (hors Mode Loupe).
let _toastEcranTimer = null;
function toastEcran(msg) {
  const t = $("toast-ecran"); if (!t) return;
  t.textContent = msg; t.classList.remove("cache");
  clearTimeout(_toastEcranTimer); _toastEcranTimer = setTimeout(() => t.classList.add("cache"), 1000);
}
// Bascule vers un moteur de lecture (re-découpe le texte en conservant la position).
function changerModele(id) {
  activerModele(id);
  if (etat.chapitresTexte) {
    if (etat.mots && etat.mots.length) etat.progression = etat.index / etat.mots.length;
    retokeniser();
    remplirSelectChapitres();
    placerMarqueursChapitres();
  }
  etat.elan = 1;
  afficherChunk();
  const sel = $("reglage-modele"); if (sel) sel.value = etat.modeleId;
}
// Appui long sur ✖ : fait défiler les moteurs (BookReeder → HotGato → Hybride → …).
function cyclerMoteur() {
  const ids = Object.keys(MODELES);
  const suiv = ids[(ids.indexOf(etat.modeleId) + 1) % ids.length];
  changerModele(suiv);
  toastEcran("Moteur : " + (MODELES[suiv].nom));
}
// Associe à un bouton de la loupe : APPUI SIMPLE = action ; APPUI LONG = bascule.
function ctxBoutonLongPress(id, actionCourte, actionLongue) {
  const btn = $(id); if (!btn) return;
  let timer = null, long = false;
  btn.addEventListener("pointerdown", () => { long = false; timer = setTimeout(() => { long = true; actionLongue(); }, 500); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
  btn.addEventListener("click", () => { if (long) { long = false; return; } actionCourte(); });
}
// Bouton loupe (droite) : clic = recherche ; appui long = bascule « Texte uniforme »
// (retire tous les effets sur le texte en Mode Loupe pour une lecture classique).
ctxBoutonLongPress("ctx-recherche", ouvrirRecherche, () => {
  etat.texteUniforme = !etat.texteUniforme;
  $("ecran-contexte").classList.toggle("texte-uniforme", etat.texteUniforme);
  toastLoupe(etat.texteUniforme ? "Texte uniforme activé" : "Texte uniforme désactivé");
});
// Bouton message (gauche) : clic = annotations ; appui long = bascule « Auto-scroll »
// (le texte ne défile plus automatiquement en lecture auto Mode Loupe).
ctxBoutonLongPress("ctx-notes", ouvrirAnnotations, () => {
  etat.loupeSansScroll = !etat.loupeSansScroll;
  toastLoupe(etat.loupeSansScroll ? "Auto-scroll désactivé" : "Auto-scroll activé");
});

// Panneau « Annotations » : recense les mots du chapitre courant porteurs d'une
// note (exposant), avec le texte de la note. Clic = saut au mot (+ ouvre la bulle).
function ouvrirAnnotations() {
  const cont = $("annot-resultats");
  const { debut, fin } = bornesChapitre();
  const items = [];
  const indices = [];                          // index du mot de chaque item
  if (etat.noteParMot) {
    for (let i = debut; i < fin; i++) {
      const ns = etat.noteParMot.get(i);
      if (!ns || !ns.length) continue;
      const motVisible = coeurMot(etat.mots[i]) || etat.mots[i].replace(/ /g, " ").trim();
      ns.forEach((n) => {
        const txt = n.texte ? echHtml(n.texte) : "<i>(annotation introuvable)</i>";
        items.push('<button class="annot-item" data-i="' + i + '">' +
          '<span class="annot-num">' + echHtml(n.num) + ".</span>" +
          "<b>" + echHtml(motVisible) + "</b> — " + txt + "</button>");
        indices.push(i);
      });
    }
  }
  cont.innerHTML = items.length ? items.join("")
    : '<p class="annot-vide">Aucune annotation dans ce chapitre.</p>';
  $("panneau-annotations").classList.remove("cache");
  // Amène en vue la note la plus proche de la position de lecture courante
  // (utile quand le chapitre comporte beaucoup de notes).
  cont.scrollTop = 0;
  if (indices.length) {
    let best = 0, dmin = Infinity;
    for (let k = 0; k < indices.length; k++) {
      const d = Math.abs(indices[k] - etat.index);
      if (d < dmin) { dmin = d; best = k; }
    }
    const el = cont.querySelectorAll(".annot-item")[best];
    if (el) el.scrollIntoView({ block: "center" });
  }
}
function fermerAnnotations() { $("panneau-annotations").classList.add("cache"); }
$("annot-resultats").addEventListener("click", (e) => {
  const it = e.target.closest(".annot-item");
  if (!it) return;
  const i = Math.min(Math.max(0, +it.dataset.i), etat.mots.length - 1);
  fermerAnnotations();
  etat.index = i;
  rafraichirContexte(true);          // recentre la loupe sur le mot annoté
  const s = ctxSpans.get(i);
  if (s) ouvrirBulleNote(i, s);      // ouvre directement la bulle de la note
  sauverPosition();
});
$("panneau-annotations").addEventListener("click", (e) => {
  if (e.target.id === "panneau-annotations") fermerAnnotations();  // clic sur le fond
});

// Clic court = play/pause ; appui long (≈0,5 s) = ouvre le mode contexte.
function installerPlayLong(id) {
  const btn = $(id);
  if (!btn) return;
  let timer = null, declenche = false;
  const debut = () => { declenche = false; timer = setTimeout(() => { declenche = true; ouvrirContexte(); }, 500); };
  const fin = () => clearTimeout(timer);
  btn.addEventListener("pointerdown", debut);
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, fin));
  btn.addEventListener("click", (e) => {
    if (declenche) { declenche = false; e.preventDefault(); e.stopImmediatePropagation(); return; }
    basculerLecture();
  });
}
installerPlayLong("btn-lecture");

// Vitesse effective = vitesse de base × multiplicateur d'accélération courant
function vitesseEff() { return etat.vitesse * (etat.multAccel || 1); }
// Affiche la vitesse effective ; en gras + couleur repère dès que le coef ≠ ×1.
function majVitesseAffichee() {
  const eff = Math.round(vitesseEff());
  const accel = (etat.coefAccel || 1) > 1.0001;   // mode accélération actif
  ["vitesse-actuelle", "ep-vitesse"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.textContent = eff;
    el.classList.toggle("accel", accel);
  });
}
// Rampe d'accélération : +0,1× toutes les 10 s pendant la lecture, jusqu'au coef visé.
function demarrerAccel() {
  clearInterval(etat.minuteurAccel);
  if (etat.coefAccel > 1 && etat.enLecture) {
    etat.minuteurAccel = setInterval(() => {
      if (etat.multAccel < etat.coefAccel) {
        etat.multAccel = Math.min(etat.coefAccel, Math.round((etat.multAccel + 0.1) * 10) / 10);
        majVitesseAffichee();
      }
    }, (etat.intervalleAccel || 10) * 1000);
  }
}
// Vitesse : − et + par paliers de 20 mots/min (bornes 100–800)
function reglerVitesse(v, sansSauver) {
  etat.vitesse = Math.min(800, Math.max(100, v));
  if (!sansSauver) { try { localStorage.setItem("bookreeder-vitesse", etat.vitesse); } catch (e) {} }   // mémorisée (par livre via le profil)
  etat.multAccel = 1;       // l'usage des touches réinitialise l'accélération
  demarrerAccel();          // et relance la rampe (10 s à partir de maintenant)
  majVitesseAffichee();
  majDureeChapitre();   // l'estimation dépend de la vitesse
}
$("btn-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 20));
$("btn-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 20));
$("ep-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 20));
$("ep-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 20));

// Retour / avance : appui court = mot par mot, appui long = phrase par phrase
// (câblé plus bas via installerNavMotPhrase, pour btn-recul/avance et ep-recul/avance).
// Chapitre précédent / suivant
$("btn-chap-prec").addEventListener("click", () => allerChapitre(-1));
$("btn-chap-suiv").addEventListener("click", () => allerChapitre(1));

// Article chargé en ligne (non enregistré) : à la fermeture, proposer de le garder.
// Petite fenêtre Oui/Non (remplace confirm natif). Renvoie une promesse booléenne.
function demanderGarderArticle() {
  return new Promise((resolve) => {
    const panneau = $("panneau-garder-article");
    const oui = $("garder-oui"), non = $("garder-non");
    const fin = (val) => {
      panneau.classList.add("cache");
      oui.removeEventListener("click", onOui); non.removeEventListener("click", onNon);
      resolve(val);
    };
    const onOui = () => fin(true), onNon = () => fin(false);
    oui.addEventListener("click", onOui); non.addEventListener("click", onNon);
    panneau.classList.remove("cache");
  });
}
async function garderArticleSiBesoin() {
  if (!etat.articleEnAttente) return;
  const a = etat.articleEnAttente;
  etat.articleEnAttente = null;
  if (!(await demanderGarderArticle())) return;
  const total = etat.mots.length;
  const fiche = {
    id: "url|" + a.url, nom: a.titre, titre: a.titre, auteur: a.source || "",
    dateAjout: Date.now(), chapitresTexte: etat.chapitresTexte, notes: etat.notes || [],
    persos: etat.persos || null, profil: etat.profil || {},
    progression: total ? etat.index / total : 0, total,
  };
  await sauverLivre(fiche);
  etat.idLivre = fiche.id;   // pour que la position se sauvegarde ensuite
}
// ✖ : appui simple = changer de livre ; appui long = basculer de moteur de lecture.
ctxBoutonLongPress("btn-fermer", async () => {
  pause();
  await garderArticleSiBesoin();
  await sauverPosition();
  ecranLecture.classList.add("cache");
  ecranAccueil.classList.remove("cache");
  $("input-fichier").value = "";
  $("message-chargement").textContent = "";
  afficherBibliotheque();
  if (typeof rafraichirBulleLireMoi === "function") rafraichirBulleLireMoi();
}, cyclerMoteur);

// =========================================================
//  Curseur déplaçable sur la barre (souris + tactile)
// =========================================================
// Petit utilitaire : ratio (0–1) d'un événement pointeur sur un élément
function ratioPointeur(el, e) {
  const r = el.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

// Barre principale : déplacement DANS le chapitre courant
const barre = $("barre-progression");
let glisse = false;
function indexBarreChapitre(e) {
  const { debut, fin } = bornesChapitre();
  return debut + Math.round(ratioPointeur(barre, e) * Math.max(0, fin - debut - 1));
}
barre.addEventListener("pointerdown", (e) => {
  if (!etat.mots.length) return;
  glisse = true;
  pause();
  barre.setPointerCapture(e.pointerId);
  etat.index = indexBarreChapitre(e);
  afficherChunk();
});
barre.addEventListener("pointermove", (e) => {
  if (!glisse) return;
  etat.index = indexBarreChapitre(e);
  afficherChunk();
});
barre.addEventListener("pointerup", (e) => {
  if (!glisse) return;
  glisse = false;
  barre.releasePointerCapture(e.pointerId);
  majDureeChapitre();
  sauverPosition();
});

// Barre du livre entier (panneau navigation) : déplacement global
const barreLivre = $("barre-livre");
let glisseLivre = false;
function indexBarreLivre(e) {
  return Math.round(ratioPointeur(barreLivre, e) * (etat.mots.length - 1));
}
barreLivre.addEventListener("pointerdown", (e) => {
  if (!etat.mots.length) return;
  glisseLivre = true;
  pause();
  barreLivre.setPointerCapture(e.pointerId);
  etat.index = indexBarreLivre(e);
  afficherChunk();
});
barreLivre.addEventListener("pointermove", (e) => {
  if (!glisseLivre) return;
  etat.index = indexBarreLivre(e);
  afficherChunk();
});
barreLivre.addEventListener("pointerup", (e) => {
  if (!glisseLivre) return;
  glisseLivre = false;
  barreLivre.releasePointerCapture(e.pointerId);
  majDureeChapitre();
  sauverPosition();
});

// =========================================================
//  Panneau de navigation (chapitre + position %)
// =========================================================
function ouvrirNavigation() {
  pause();   // on arrête la lecture pendant la navigation
  navDepuisLoupe = false;
  $("nav-chapitre").value = etat.chapitres.indexOf(chapitreActuel());
  $("panneau-navigation").classList.remove("cache");
  majBarreLivre();
}
$("zone-navigation").addEventListener("click", ouvrirNavigation);
// Mode Minimaliste (horizontal & vertical) : toucher la zone d'infos (chapitre en
// cours) ouvre la Navigation (et met la lecture en pause via ouvrirNavigation).
$("infos-minimal")?.addEventListener("click", ouvrirNavigation);
// En Mode Loupe : toucher la ligne d'infos du chapitre ouvre la navigation SANS
// quitter la loupe (on y revient après le choix).
let navDepuisLoupe = false;
$("contexte-infos").addEventListener("click", () => {
  pause();   // arrête aussi la lecture auto en Mode Loupe pendant la navigation
  navDepuisLoupe = true;
  $("nav-chapitre").value = etat.chapitres.indexOf(chapitreActuel());
  $("panneau-navigation").classList.remove("cache");
  majBarreLivre();
});

// Panneau d'aide / fonctionnalités (accueil)
$("btn-infos").addEventListener("click", () => $("panneau-infos").classList.remove("cache"));
$("btn-fermer-infos").addEventListener("click", () => $("panneau-infos").classList.add("cache"));

// --- Raccourci iOS « Partager » : popup de validation, puis lien iCloud (à venir)
//     ou guide de création en attendant. ---
const LIEN_RACCOURCI_IOS = "https://www.icloud.com/shortcuts/48638b4a576f48d483d33f13a5e83807";   // lien iCloud du Raccourci « Ouvrir avec BookReeder »
$("btn-raccourci-ios")?.addEventListener("click", () => {
  $("raccourci-guide").classList.add("cache");
  $("raccourci-boutons").classList.remove("cache");
  $("panneau-raccourci").classList.remove("cache");
});
$("raccourci-non")?.addEventListener("click", () => $("panneau-raccourci").classList.add("cache"));
$("panneau-raccourci")?.addEventListener("click", (e) => { if (e.target === $("panneau-raccourci")) $("panneau-raccourci").classList.add("cache"); });
$("raccourci-oui")?.addEventListener("click", () => {
  if (LIEN_RACCOURCI_IOS) { window.open(LIEN_RACCOURCI_IOS, "_blank"); $("panneau-raccourci").classList.add("cache"); return; }
  // Pas encore de lien : on affiche les étapes pour le créer soi-même.
  $("raccourci-boutons").classList.add("cache");
  $("raccourci-guide").classList.remove("cache");
});
$("raccourci-fermer-guide")?.addEventListener("click", () => $("panneau-raccourci").classList.add("cache"));
$("raccourci-copier")?.addEventListener("click", async () => {
  const base = location.origin + location.pathname + "?url=";
  try { await navigator.clipboard.writeText(base); $("raccourci-copier").textContent = "Adresse copiée ✓"; }
  catch (e) { $("raccourci-copier").textContent = base; }
});

// --- Ajouter à l'écran d'accueil (PWA) ---
// Android/Chrome : on capte l'invite native pour la déclencher au clic.
// iOS/Safari : pas d'API → on affiche la marche à suivre (Partager → écran d'accueil).
let inviteInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  inviteInstall = e;
});
(function initBoutonInstall() {
  const dejaInstallee = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  const btn = $("btn-ajouter-accueil");
  if (dejaInstallee && btn) { btn.style.display = "none"; return; }   // déjà sur l'écran d'accueil
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (inviteInstall) {                       // Android : invite native
      inviteInstall.prompt();
      try { await inviteInstall.userChoice; } catch (e) {}
      inviteInstall = null;
      $("aide-install").textContent = "";
      return;
    }
    const ua = navigator.userAgent || "";
    const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
    $("aide-install").textContent = ios
      ? "Sur iPhone/iPad : touchez le bouton Partager (carré avec une flèche ↑) en bas de Safari, puis « Sur l'écran d'accueil »."
      : "Ouvrez le menu de votre navigateur (⋮), puis « Ajouter à l'écran d'accueil » / « Installer l'application ».";
  });
})();
$("btn-fermer-navigation").addEventListener("click", () => {
  $("panneau-navigation").classList.add("cache");
  // Si on avait ouvert la navigation DEPUIS la loupe, on y revient à la nouvelle
  // position (la loupe est restée affichée dessous).
  if (navDepuisLoupe && !$("ecran-contexte").classList.contains("cache")) rafraichirContexte(true);
  navDepuisLoupe = false;
  sauverPosition();
});
$("nav-chapitre").addEventListener("change", (e) => {
  const ch = etat.chapitres[+e.target.value];
  if (!ch) return;
  deplacer(ch.debut - etat.index, true);
});
// Boutons chapitre précédent / suivant du panneau Navigation
function navChapPanneau(dir) {
  allerChapitre(dir);
  $("nav-chapitre").value = etat.chapitres.indexOf(chapitreActuel());
  majBarreLivre();
}
$("nav-chap-prec").addEventListener("click", () => navChapPanneau(-1));
$("nav-chap-suiv").addEventListener("click", () => navChapPanneau(1));

// --- Choix de la table des matières (popup + lien « Reconstruire ») ---
$("lien-reconstruire-toc")?.addEventListener("click", ouvrirChoixTOC);
$("toc-existante")?.addEventListener("click", () => choisirModeTOC("existante"));
$("toc-optimisee")?.addEventListener("click", () => choisirModeTOC("optimisee"));
$("toc-annuler")?.addEventListener("click", () => $("panneau-toc").classList.add("cache"));
// Toucher la zone hors carte ferme le popup (garde le mode courant).
$("panneau-toc")?.addEventListener("click", (e) => { if (e.target.id === "panneau-toc") $("panneau-toc").classList.add("cache"); });

// =========================================================
//  Bibliothèque sur l'écran d'accueil
// =========================================================
const fracLivre = (l) => l.progression != null ? l.progression : (l.total ? (l.index || 0) / l.total : 0);
let triBiblio = "ajout";   // ajout | alpha | avancement
try { triBiblio = localStorage.getItem("bookreeder-tri-biblio") || "ajout"; } catch (e) {}
const LIBELLE_TRI_BIBLIO = { ajout: "par ordre d'ajout", alpha: "alphabétique", avancement: "avancement" };
// Mode d'affichage de la 3ᵉ ligne des items (clic sur « Mes lectures ») :
// 0 = date gauche + % droite ; 1 = % gauche + date droite ; 2 = date + % à la suite ;
// 3 = % + date à la suite ; 4 = % seul.
let metaBiblio = 0;
try { metaBiblio = +(localStorage.getItem("bookreeder-meta-biblio") || 0) || 0; } catch (e) {}
function metaBiblioHTML(pct, dateStr) {
  const d = `<span class="item-date">ajouté ${dateStr}</span>`;
  const p = `<span class="item-pct">${pct} %</span>`;
  const sep = `<span class="item-sep">·</span>`;
  switch (metaBiblio) {
    case 1: return { cls: "meta-spread", html: p + d };          // % gauche, date droite
    case 2: return { cls: "meta-suite", html: d + sep + p };     // date gauche, % à la suite
    case 3: return { cls: "meta-suite", html: p + sep + d };     // % gauche, date à la suite
    case 4: return { cls: "meta-suite", html: p };               // % seul
    default: return { cls: "meta-spread", html: d + p };         // 0 : date gauche, % droite
  }
}
// Efface le profil de lecture d'un livre (réglages + couleurs persos) en gardant
// la progression et le livre dans la liste.
async function proposerEffacerProfil(livre) {
  const r = await choix(
    "Effacer les données de « " + (livre.titre || livre.nom) + " » ?\nRéglages, couleurs des personnages et choix de table des matières seront remis à zéro.",
    [
      { label: "Tout effacer (avec la progression)", val: "tout", classe: "choix-danger" },
      { label: "Garder la progression", val: "garder" },
      { label: "Annuler", val: null, classe: "choix-annuler" },
    ]
  );
  if (!r) return;
  const f = await lireLivre(livre.id);
  if (f) {
    f.profil = {};                       // réglages par livre → défaut
    delete f.persos;                     // cache des personnages → re-détection
    if (r === "tout") { f.progression = 0; f.total = f.total || 0; }  // remet au début
    await sauverLivre(f);
  }
  try { localStorage.removeItem("bookreeder-toc-" + livre.id); } catch (e) {}  // choix TOC → re-demandé
  if (etat.idLivre === livre.id) {
    etat.profil = {};
    if (r === "tout") { etat.index = 0; }
  }
  afficherBibliotheque();
}
async function afficherBibliotheque() {
  const conteneur = $("bibliotheque");
  conteneur.innerHTML = "";
  const titre = $("titre-lectures");
  let livres = [];
  try { livres = (await listerLivres()) || []; } catch (e) { if (titre) titre.style.display = "none"; return; }
  if (triBiblio === "alpha") livres.sort((a, b) => (a.titre || a.nom || "").localeCompare(b.titre || b.nom || "", "fr"));
  else if (triBiblio === "avancement") livres.sort((a, b) => fracLivre(b) - fracLivre(a));
  else livres.sort((a, b) => b.dateAjout - a.dateAjout);
  if (titre) {
    titre.style.display = livres.length ? "block" : "none";
    // « Mes lectures : <mode> ⇅ » — « Mes lectures » cycle l'affichage de la 3ᵉ
    // ligne des items ; la partie <mode> cycle le tri.
    titre.innerHTML = "<button id=\"meta-biblio\" class=\"titre-lien\">Mes lectures</button>&nbsp;: <button id=\"tri-biblio\" class=\"tri-lien\"></button>";
    $("meta-biblio").addEventListener("click", () => {
      metaBiblio = (metaBiblio + 1) % 5;
      try { localStorage.setItem("bookreeder-meta-biblio", metaBiblio); } catch (e) {}
      afficherBibliotheque();
    });
    const lien = $("tri-biblio");
    lien.textContent = LIBELLE_TRI_BIBLIO[triBiblio];
    lien.addEventListener("click", () => {
      triBiblio = triBiblio === "ajout" ? "alpha" : triBiblio === "alpha" ? "avancement" : "ajout";
      try { localStorage.setItem("bookreeder-tri-biblio", triBiblio); } catch (e) {}
      afficherBibliotheque();
    });
  }
  if (!livres.length) return;

  livres.forEach((livre) => {
    const pct = Math.round(fracLivre(livre) * 100);
    const item = document.createElement("div");
    item.className = "item-livre";
    item.innerHTML =
      `<div class="item-infos">` +
        `<span class="item-nom"></span>` +
        `<span class="item-auteur"></span>` +
        `<span class="item-meta ${metaBiblioHTML(pct, formatDate(livre.dateAjout)).cls}">${metaBiblioHTML(pct, formatDate(livre.dateAjout)).html}</span>` +
      `</div>` +
      `<button class="item-suppr" title="Retirer">×</button>`;
    // Titre du livre (métadonnées) si dispo, sinon nom de fichier
    item.querySelector(".item-nom").textContent = livre.titre || livre.nom;
    const elAuteur = item.querySelector(".item-auteur");
    if (livre.auteur) elAuteur.textContent = livre.auteur;
    else elAuteur.remove();
    // Clic = ouvrir ; appui long (≈0,5 s) = proposer d'effacer le profil de lecture.
    const infos = item.querySelector(".item-infos");
    let long = false, timer = null;
    const annule = () => { if (timer) { clearTimeout(timer); timer = null; } };
    infos.addEventListener("pointerdown", () => { long = false; timer = setTimeout(() => { long = true; proposerEffacerProfil(livre); }, 500); });
    infos.addEventListener("pointerup", annule);
    infos.addEventListener("pointerleave", annule);
    infos.addEventListener("pointercancel", annule);
    infos.addEventListener("click", async () => {
      if (long) { long = false; return; }
      const frais = await lireLivre(livre.id); // position à jour
      ouvrirFiche(frais || livre);
    });
    item.querySelector(".item-suppr").addEventListener("click", async (e) => {
      e.stopPropagation();
      await supprimerLivre(livre.id);
      try { localStorage.removeItem("bookreeder-toc-" + livre.id); } catch (er) {}  // re-demande la TOC au prochain chargement
      afficherBibliotheque();
    });
    conteneur.appendChild(item);
  });
}
afficherBibliotheque();
initialiserModeles();
// Marque les lignes de réglage contenant un slider (pour l'espacement resserré CSS),
// sans dépendre du sélecteur :has() (pas garanti sur tous les iPhone).
document.querySelectorAll('#panneau-reglages input[type="range"]').forEach((inp) => {
  const ligne = inp.closest(".reglage"); if (ligne) ligne.classList.add("ligne-slider");
});

// Numéro de version = compteur de déploiement (?v=N de app.js, N/100), bumpé une
// fois par push. Affiché dans la signature et dans « Vérifier les mises à jour ».
function versionApp() {
  const sc = [...document.querySelectorAll("script")].find((x) => /app\.js/.test(x.src));
  const mv = sc && sc.src.match(/[?&]v=(\d+)/);
  return mv ? (mv[1] / 100).toFixed(2) : null;
}
(function majSignature() {
  const el = $("sig-version");
  const v = versionApp();
  if (el && v) el.textContent = v;
})();

// Info-bulle « Lisez-moi ! » vers le (i) : 1re ouverture ou changement de version.
// Le (i) n'existe que sur l'écran d'accueil → la bulle ne vit que sur l'accueil.
// Elle reste « active » (réapparaît à chaque retour à l'accueil) tant qu'on n'a
// pas cliqué dessus ou ouvert le (i).
let bulleActive = false;
// La bulle n'est « autorisée » à apparaître qu'une fois la vérification de mise à
// jour du service worker terminée : si un rechargement auto est imminent (nouvelle
// version), on garde la bulle masquée pour qu'elle n'apparaisse qu'APRÈS le reload
// (sinon elle clignote : apparaît → reload → réapparaît).
let bulleAutorisee = false;
function autoriserBulle() { bulleAutorisee = true; rafraichirBulleLireMoi(); }
function positionnerBulle() {
  const btn = $("btn-infos"), bulle = $("bulle-liremoi");
  if (!btn || !bulle) return;
  const r = btn.getBoundingClientRect();
  bulle.style.top = (r.bottom + 10) + "px";
  bulle.style.right = Math.max(8, window.innerWidth - r.right) + "px";
}
// Masquage permanent (clic sur la bulle ou ouverture du (i)) : c'est SEULEMENT
// ici qu'on marque la version comme « vue » → la bulle persiste tant qu'on ne l'a
// pas réellement vue (même après plusieurs rechargements).
function cacherBulleLireMoi() {
  bulleActive = false;
  $("bulle-liremoi").classList.add("cache");
  try { const v = versionApp(); if (v) localStorage.setItem("bookreeder-vue-version", v); } catch (e) {}
}
// Affiche la bulle si elle est encore active ET qu'on est sur l'accueil.
function rafraichirBulleLireMoi() {
  const bulle = $("bulle-liremoi");
  if (!bulle) return;
  const surAccueil = !ecranAccueil.classList.contains("cache");
  if (bulleActive && bulleAutorisee && surAccueil) { positionnerBulle(); bulle.classList.remove("cache"); }
  else { bulle.classList.add("cache"); }
}
$("btn-infos").addEventListener("click", cacherBulleLireMoi);
$("bulle-liremoi").addEventListener("click", cacherBulleLireMoi);
(function initBulleLireMoi() {
  let vue = null;
  try { vue = localStorage.getItem("bookreeder-vue-version"); } catch (e) {}
  const v = versionApp();
  if (v && vue !== v) {
    // On NE marque PAS encore « vue » : ce sera fait au clic bulle / ouverture (i).
    bulleActive = true;
  }
  // Sans service worker, aucun rechargement auto possible → on peut autoriser tout
  // de suite (le bloc SW s'en charge sinon, après sa vérification de mise à jour).
  if (!("serviceWorker" in navigator)) setTimeout(autoriserBulle, 500);
})();

// Réglages : on met en pause et on fait monter la zone de lecture en aperçu (1/3
// haut) pendant que le panneau occupe les 2/3 du bas ; à la fermeture, on
// ré-affiche le chunk pour appliquer proprement tous les réglages.
// Réglages paginés (3 pages navigables ‹ ›), titre + OK toujours visibles.
let reglagesPage = 0;
const REGLAGES_NB_PAGES = 4;
function montrerReglagesPage(n) {
  reglagesPage = (n + REGLAGES_NB_PAGES) % REGLAGES_NB_PAGES;
  document.querySelectorAll("#reglages-pages .reglages-page").forEach((p) => {
    p.classList.toggle("cache", +p.dataset.page !== reglagesPage);
  });
  $("reglages-titre").textContent = "Réglages " + (reglagesPage + 1) + "/" + REGLAGES_NB_PAGES;
  const pages = $("reglages-pages"); if (pages) pages.scrollTop = 0;
}
$("reglages-prec").addEventListener("click", () => montrerReglagesPage(reglagesPage - 1));
$("reglages-suiv").addEventListener("click", () => montrerReglagesPage(reglagesPage + 1));
function ouvrirReglages() {
  pause();
  ecranLecture.classList.add("apercu");
  montrerReglagesPage(0);
  $("panneau-reglages").classList.remove("cache");
  afficherChunk();
}
// ⚙ : clic court = Réglages ; appui long (≈0,5 s) = panneau « Dialogues dynamiques ».
(function brancherBoutonReglages() {
  const btn = $("btn-reglages"); let long = false, timer = null;
  const annule = () => { if (timer) { clearTimeout(timer); timer = null; } };
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(() => { long = true; ouvrirDialoguesDyn(); }, 500);
  });
  btn.addEventListener("pointerup", annule);
  btn.addEventListener("pointerleave", annule);
  btn.addEventListener("pointercancel", annule);
  btn.addEventListener("click", () => { if (long) { long = false; return; } ouvrirReglages(); });
})();
$("btn-ouvrir-dialogues-dyn")?.addEventListener("click", () => { fermerReglages(); ouvrirDialoguesDyn(); });
function fermerReglages() {
  $("panneau-reglages").classList.add("cache");
  ecranLecture.classList.remove("apercu");
  afficherChunk(); // re-rendu complet avec les réglages finaux
}
// Bouton « OK » + toucher la zone au-dessus du panneau (hors carte) : valide et referme.
$("btn-fermer-reglages")?.addEventListener("click", fermerReglages);
$("panneau-reglages").addEventListener("click", (e) => {
  if (e.target === $("panneau-reglages")) fermerReglages();
});

// =========================================================
//  Panneau « Dialogues dynamiques » : attribution des couleurs par personnage
// =========================================================
function ouvrirDialoguesDyn() {
  pause();
  const apres = () => {
    if (window.MoteurDialogues) {
      if (!etat.persos || !etat.persos.resolution) { etat.persos = window.MoteurDialogues.analyserPersonnages(); planifierSauvegardeProfil(); }
      if (etat.mots && etat.mots.length) window.MoteurDialogues.calculerLocuteurs();   // remplit baseCouleurPerso
    }
    renderListePersos();
    ecranLecture.classList.add("apercu");
    $("panneau-dialogues-dyn").classList.remove("cache");
    afficherChunk();
  };
  if (window.MoteurDialogues) apres(); else chargerMoteurDialogues(apres);
}
function fermerDialoguesDyn() {
  $("panneau-dialogues-dyn").classList.add("cache");
  ecranLecture.classList.remove("apercu");
  afficherChunk();
}
$("btn-fermer-dialogues-dyn")?.addEventListener("click", fermerDialoguesDyn);
$("panneau-dialogues-dyn").addEventListener("click", (e) => {
  if (e.target === $("panneau-dialogues-dyn")) fermerDialoguesDyn();
});
$("reglage-cacher-noms")?.addEventListener("change", (e) => {
  try { localStorage.setItem("bookreeder-cacher-noms", e.target.checked ? "1" : "0"); } catch (err) {}
  renderListePersos();
});

const hexOk = (c) => /^#[0-9a-fA-F]{6}$/.test(c || "");
// Fixe (ou met à jour) la couleur d'un personnage : mémorisée par livre (profil),
// recalcul des couleurs et re-rendu.
function sauverCouleursPersos() {
  try { localStorage.setItem("bookreeder-perso-couleurs", JSON.stringify(etat.couleursPersonnages || {})); } catch (e) {}
  if (window.MoteurDialogues && etat.mots && etat.mots.length) window.MoteurDialogues.calculerLocuteurs();
  afficherChunk();
}
function attribuerCouleurPerso(cle, hex) {
  if (!etat.couleursPersonnages) etat.couleursPersonnages = {};
  etat.couleursPersonnages[cle] = hex;
  sauverCouleursPersos();
  // Aperçu de lecture mis à jour si l'effet multicolore est actif. On NE
  // reconstruit PAS la liste : la pastille (= l'input) affiche déjà sa couleur,
  // et re-générer la liste pendant l'usage referme/déstabilise le sélecteur.
  if (typeof effetDialogue === "function" && effetDialogue("multicolore") &&
      window.MoteurDialogues && etat.mots && etat.mots.length) {
    window.MoteurDialogues.calculerLocuteurs();
    if (!ecranLecture.classList.contains("cache")) afficherChunk();
  }
}
function pastillePerso(cle, hexCourant) {
  const inp = document.createElement("input");
  inp.type = "color"; inp.className = "perso-pastille";
  inp.value = hexOk(hexCourant) ? hexCourant : "#888888";
  // « change » (pas « input ») : la couleur n'est appliquée qu'au relâchement /
  // à la fermeture du sélecteur natif, jamais en continu pendant la sélection.
  inp.addEventListener("change", () => attribuerCouleurPerso(cle, inp.value));
  return inp;
}
let triPersos = "apparition";   // apparition | alpha | bavardage
const LIBELLE_TRI = { apparition: "Par ordre d'apparition", alpha: "Par ordre alphabétique", bavardage: "Par poids de bavardage" };
function indiceBavardage() { const s = $("reglage-indice-bavardage"); return s ? s.value : "masque"; }
// Rang de bavardage (0 = plus de répliques) par personnage, pour les étoiles.
function rangsBavardage() {
  const m = {};
  ((etat.persos && etat.persos.nommes) || []).filter((p) => p.count >= 2)
    .slice().sort((a, b) => b.count - a.count).forEach((p, i) => { m[p.cle] = i; });
  return m;
}
// Étoile « poids » selon le mode : simple = ★ blanche (top 6) ; podium = 2 or, 2
// argent, 2 bronze. Ne révèle pas l'identité.
function etoilePoids(rang) {
  const mode = indiceBavardage();
  if (mode === "masque" || rang == null || rang >= 6) return null;
  const et = document.createElement("span"); et.className = "perso-etoile"; et.textContent = "★";
  if (mode === "simple") et.classList.add("blanc");
  else et.classList.add(rang < 2 ? "or" : rang < 4 ? "argent" : "bronze");
  return et;
}
function renderListePersos() {
  const cont = $("liste-persos"); if (!cont) return;
  cont.innerHTML = "";
  const ov = etat.couleursPersonnages || {};
  const base = etat.baseCouleurPerso || {};
  const cacher = $("reglage-cacher-noms") ? $("reglage-cacher-noms").checked : true;
  const rangs = rangsBavardage();
  let liste = ((etat.persos && etat.persos.nommes) || []).filter((p) => p.count >= 2).slice();
  if (triPersos === "bavardage") liste.sort((a, b) => b.count - a.count);
  else if (triPersos === "alpha") liste.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  else liste.sort((a, b) => a.first - b.first);   // apparition
  liste.forEach((p) => {
    const masque = cacher && p.first > etat.index;
    const ligne = document.createElement("div"); ligne.className = "perso-ligne";
    // Zone cliquable = <label> contenant la pastille (input color) + le nom. Taper
    // n'importe où ouvre la roue chromatique : l'activation par <label> est native,
    // donc honorée même sur iPhone (contrairement à un .click() programmatique).
    const zone = document.createElement("label"); zone.className = "perso-couleur-zone";
    const past = pastillePerso(p.cle, ov[p.cle] || base[p.cle]);
    zone.appendChild(past);
    const nom = document.createElement("span");
    nom.className = "perso-nom" + (masque ? " masque" : "");
    nom.textContent = masque ? "Personnage à venir" : p.nom;
    zone.appendChild(nom);
    ligne.appendChild(zone);
    const et = etoilePoids(rangs[p.cle]);
    if (et) ligne.appendChild(et);
    // Nombre d'occurrences (somme du bucket) — affiché UNIQUEMENT quand le tri est
    // « Par poids de bavardage » ET que le masquage anti-spoil est décoché (le compte
    // révèle l'importance du personnage).
    if (!cacher && triPersos === "bavardage") { const cpt = document.createElement("span"); cpt.className = "perso-compte"; cpt.textContent = p.count; ligne.appendChild(cpt); }
    const xb = document.createElement("button"); xb.className = "perso-suppr"; xb.textContent = "✕"; xb.title = "Supprimer / fusionner ce personnage";
    xb.addEventListener("click", (e) => { e.stopPropagation(); ouvrirPersoAction(p.cle, masque ? "ce personnage" : p.nom); });
    ligne.appendChild(xb);
    // Appui long → bucket. On annule alors l'ouverture de la roue (preventDefault
    // sur le clic du label, qui sinon activerait l'input color au relâchement).
    let lpT = null, long = false;
    const annuleLp = () => { if (lpT) { clearTimeout(lpT); lpT = null; } };
    zone.addEventListener("pointerdown", () => { long = false; lpT = setTimeout(() => { long = true; ouvrirBucket(p.cle); }, 500); });
    zone.addEventListener("pointerup", annuleLp);
    zone.addEventListener("pointerleave", annuleLp);
    zone.addEventListener("pointercancel", annuleLp);
    zone.addEventListener("click", (e) => { if (long) { e.preventDefault(); long = false; } });
    cont.appendChild(ligne);
  });
  const tri = $("dd-tri"); if (tri) tri.textContent = LIBELLE_TRI[triPersos];
  renderTiers();
}
// Ligne « Personnages tiers », SOUS la liste (féminin à gauche pilote, masculin
// à droite suit sauf modif manuelle).
function renderTiers() {
  const cont = $("dd-tiers"); if (!cont) return;
  cont.innerHTML = "";
  const data = etat.persos;
  if (!data || !data.tiers || !data.tiers.total) return;
  const ov = etat.couleursPersonnages || {};
  const cF = ov["tiers-f"] || COUL_SEC2;
  const cM = ov["tiers-m"] || cF;
  const ligne = document.createElement("div"); ligne.className = "perso-ligne tiers";
  const nom = document.createElement("span"); nom.className = "perso-nom"; nom.textContent = "Personnages tiers";
  const sw = document.createElement("span"); sw.className = "tiers-swatches";
  const gF = document.createElement("span"); gF.className = "tiers-g"; gF.textContent = "♀";
  const inpF = document.createElement("input"); inpF.type = "color"; inpF.className = "perso-pastille"; inpF.value = hexOk(cF) ? cF : "#888888";
  const gM = document.createElement("span"); gM.className = "tiers-g"; gM.textContent = "♂";
  const inpM = document.createElement("input"); inpM.type = "color"; inpM.className = "perso-pastille"; inpM.value = hexOk(cM) ? cM : "#888888";
  inpF.addEventListener("input", () => {
    if (!etat.couleursPersonnages) etat.couleursPersonnages = {};
    etat.couleursPersonnages["tiers-f"] = inpF.value;
    if (!etat.couleursPersonnages["_tiersMlibre"]) etat.couleursPersonnages["tiers-m"] = inpF.value;
    sauverCouleursPersos(); renderTiers();
  });
  inpM.addEventListener("input", () => {
    if (!etat.couleursPersonnages) etat.couleursPersonnages = {};
    etat.couleursPersonnages["tiers-m"] = inpM.value;
    etat.couleursPersonnages["_tiersMlibre"] = true;
    sauverCouleursPersos(); renderTiers();
  });
  sw.appendChild(gF); sw.appendChild(inpF); sw.appendChild(gM); sw.appendChild(inpM);
  ligne.appendChild(nom); ligne.appendChild(sw);
  cont.appendChild(ligne);
}
$("dd-tri")?.addEventListener("click", () => {
  triPersos = triPersos === "apparition" ? "alpha" : triPersos === "alpha" ? "bavardage" : "apparition";
  renderListePersos();
});
$("reglage-indice-bavardage")?.addEventListener("change", (e) => {
  try { localStorage.setItem("bookreeder-indice-bavardage", e.target.value); } catch (err) {}
  renderListePersos();
});

// =========================================================
//  Bucket d'un personnage : formes détectées, curation (par livre)
// =========================================================
let bucketCleCourant = null, baFormeCourante = null;
function sauverCuration() { try { localStorage.setItem("bookreeder-persos-curation", JSON.stringify(etat.persosCuration || {})); } catch (e) {} }
function appliquerCuration() {
  sauverCuration();
  if (window.MoteurDialogues) { window.MoteurDialogues.analyserPersonnages(); if (etat.mots && etat.mots.length) window.MoteurDialogues.calculerLocuteurs(); }
  renderListePersos();
  if (!ecranLecture.classList.contains("cache")) afficherChunk();
}
function persoParCle(cle) { return ((etat.persos && etat.persos.nommes) || []).find((p) => p.cle === cle); }
// Petite fenêtre de confirmation générique (Oui/Non) → promesse booléenne.
function confirmer(message) {
  return new Promise((resolve) => {
    const p = $("panneau-confirm"); if (!p) { resolve(window.confirm(message)); return; }
    $("confirm-titre").textContent = message;
    const oui = $("confirm-oui"), non = $("confirm-non");
    const fin = (v) => { p.classList.add("cache"); oui.removeEventListener("click", onO); non.removeEventListener("click", onN); resolve(v); };
    const onO = () => fin(true), onN = () => fin(false);
    oui.addEventListener("click", onO); non.addEventListener("click", onN);
    p.classList.remove("cache");
  });
}
// Dialogue à 2–3 boutons. options = [{ label, val, classe }]. Résout avec la val
// du bouton cliqué, ou null si on touche le fond.
function choix(message, options) {
  return new Promise((resolve) => {
    const p = $("panneau-choix");
    if (!p) { resolve(null); return; }
    $("choix-titre").textContent = message;
    const cont = $("choix-boutons"); cont.innerHTML = "";
    const fin = (v) => { p.classList.add("cache"); p.removeEventListener("click", onFond); resolve(v); };
    options.forEach((o) => {
      const b = document.createElement("button");
      b.textContent = o.label;
      if (o.classe) b.className = o.classe;
      b.addEventListener("click", () => fin(o.val));
      cont.appendChild(b);
    });
    const onFond = (e) => { if (e.target === p) fin(null); };
    p.addEventListener("click", onFond);
    p.classList.remove("cache");
  });
}
function ouvrirBucket(cle) { bucketCleCourant = cle; renderBucket(); $("panneau-bucket").classList.remove("cache"); }
function renderBucket() {
  const p = persoParCle(bucketCleCourant);
  if (!p) { $("panneau-bucket").classList.add("cache"); return; }
  const cacher = $("reglage-cacher-noms") ? $("reglage-cacher-noms").checked : true;
  const masque = cacher && p.first > etat.index;
  $("bucket-titre").textContent = masque ? "Personnage à venir" : p.nom;
  const pref = (etat.persosCuration && etat.persosCuration.pref) || {};
  const cont = $("bucket-liste"); cont.innerHTML = "";
  (p.bucket || []).slice().sort((a, b) => b.count - a.count).forEach((f) => {
    const ligne = document.createElement("div"); ligne.className = "bucket-ligne";
    const nom = document.createElement("span"); nom.className = "bucket-nom" + (pref[p.cle] === f.nom ? " prefere" : "");
    nom.textContent = masque ? "—" : f.nom;
    nom.addEventListener("click", () => { (etat.persosCuration = etat.persosCuration || {}).pref = etat.persosCuration.pref || {}; etat.persosCuration.pref[p.cle] = f.nom; appliquerCuration(); renderBucket(); });
    const x = document.createElement("button"); x.className = "bucket-x"; x.textContent = "✕"; x.title = "Retirer cette forme";
    x.addEventListener("click", (e) => { e.stopPropagation(); ouvrirBucketAction(f.cle, f.nom); });
    ligne.appendChild(nom);
    // Nombre d'occurrences de cette forme — masqué aussi si le perso est « à venir ».
    if (!masque) { const cpt = document.createElement("span"); cpt.className = "bucket-compte"; cpt.textContent = f.count; ligne.appendChild(cpt); }
    ligne.appendChild(x);
    cont.appendChild(ligne);
  });
}
$("btn-fermer-bucket")?.addEventListener("click", () => $("panneau-bucket").classList.add("cache"));
$("panneau-bucket")?.addEventListener("click", (e) => { if (e.target === $("panneau-bucket")) $("panneau-bucket").classList.add("cache"); });

function curEnsemble(k) { etat.persosCuration = etat.persosCuration || {}; return (etat.persosCuration[k] = etat.persosCuration[k] || {}); }
function ouvrirBucketAction(formCle, formNom) {
  baFormeCourante = formCle;
  $("ba-terme").textContent = formNom;
  $("ba-perso-liste").classList.add("cache");
  $("ba-choix").classList.remove("cache"); $("ba-supprimer").classList.remove("cache");
  $("panneau-bucket-action").classList.remove("cache");
}
function fermerBucketAction() { $("panneau-bucket-action").classList.add("cache"); }
$("panneau-bucket-action")?.addEventListener("click", (e) => { if (e.target === $("panneau-bucket-action")) fermerBucketAction(); });
$("ba-non")?.addEventListener("click", () => {                 // personnage à part
  curEnsemble("sep")[baFormeCourante] = 1;
  if (etat.persosCuration.rat) delete etat.persosCuration.rat[baFormeCourante];
  fermerBucketAction(); appliquerCuration(); renderBucket();
});
$("ba-supprimer")?.addEventListener("click", () => {           // texte normal
  curEnsemble("sup")[baFormeCourante] = 1;
  fermerBucketAction(); appliquerCuration(); renderBucket();
});
$("ba-oui")?.addEventListener("click", () => {                 // rattacher à un autre personnage
  const cont = $("ba-perso-liste"); cont.innerHTML = "";
  ((etat.persos && etat.persos.nommes) || [])
    .filter((p) => p.cle !== bucketCleCourant && p.count >= 2)
    .sort((a, b) => b.count - a.count)
    .forEach((p) => {
    const b = document.createElement("button"); b.textContent = p.nom;
    b.addEventListener("click", () => {
      curEnsemble("rat")[baFormeCourante] = p.cle;
      if (etat.persosCuration.sep) delete etat.persosCuration.sep[baFormeCourante];
      fermerBucketAction(); appliquerCuration();
      bucketCleCourant = p.cle; renderBucket();
    });
    cont.appendChild(b);
  });
  const annuler = document.createElement("button"); annuler.className = "liste-annuler"; annuler.textContent = "Annuler";
  annuler.addEventListener("click", fermerBucketAction);
  cont.appendChild(annuler);
  $("ba-choix").classList.add("cache"); $("ba-supprimer").classList.add("cache");
  cont.classList.remove("cache");
});

// --- Action sur un personnage (✕ dans la liste) : supprimer / fusionner ---
let paPersoCourant = null;
function ouvrirPersoAction(cle, nom) {
  paPersoCourant = cle;
  $("pa-nom").textContent = nom;
  $("pa-perso-liste").classList.add("cache");
  $("pa-choix").classList.remove("cache"); $("pa-fusionner").classList.remove("cache");
  $("panneau-perso-action").classList.remove("cache");
}
function fermerPersoAction() { $("panneau-perso-action").classList.add("cache"); }
$("panneau-perso-action")?.addEventListener("click", (e) => { if (e.target === $("panneau-perso-action")) fermerPersoAction(); });
$("pa-non")?.addEventListener("click", fermerPersoAction);
$("pa-oui")?.addEventListener("click", () => {                 // Supprimer le personnage (toutes ses formes → texte normal)
  const b = (persoParCle(paPersoCourant) || {}).bucket || [];
  b.forEach((f) => { curEnsemble("sup")[f.cle] = 1; });
  fermerPersoAction(); appliquerCuration();
});
let triFusion = "bavardage";   // apparition | alpha | bavardage (tri de la liste de fusion)
function renderListeFusion() {
  const cont = $("pa-perso-liste"); cont.innerHTML = "";
  // Sélecteur de tri cliquable (même logique que la Feuille de personnages).
  const tri = document.createElement("button"); tri.className = "fusion-tri";
  tri.textContent = LIBELLE_TRI[triFusion] + "  ⇅";
  tri.addEventListener("click", () => {
    triFusion = triFusion === "apparition" ? "alpha" : triFusion === "alpha" ? "bavardage" : "apparition";
    renderListeFusion();
  });
  cont.appendChild(tri);
  let liste = ((etat.persos && etat.persos.nommes) || []).filter((p) => p.cle !== paPersoCourant && p.count >= 2);
  if (triFusion === "bavardage") liste.sort((a, b) => b.count - a.count);
  else if (triFusion === "alpha") liste.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  else liste.sort((a, b) => a.first - b.first);
  liste.forEach((p) => {
    const btn = document.createElement("button"); btn.textContent = p.nom;
    btn.addEventListener("click", () => {
      const b = (persoParCle(paPersoCourant) || {}).bucket || [];
      b.forEach((f) => { curEnsemble("rat")[f.cle] = p.cle; if (etat.persosCuration.sep) delete etat.persosCuration.sep[f.cle]; });
      fermerPersoAction(); appliquerCuration();
    });
    cont.appendChild(btn);
  });
  const annuler = document.createElement("button"); annuler.className = "liste-annuler"; annuler.textContent = "Annuler";
  annuler.addEventListener("click", fermerPersoAction);
  cont.appendChild(annuler);
}
$("pa-fusionner")?.addEventListener("click", () => {           // Fusionner ce perso (et son bucket) dans un autre
  renderListeFusion();
  $("pa-choix").classList.add("cache"); $("pa-fusionner").classList.add("cache");
  $("pa-perso-liste").classList.remove("cache");
});
// Génère des couleurs DISTINCTES par personnage, calées sur l'intensité (saturation
// / luminosité) de la palette du thème actif. Teintes réparties par l'angle d'or
// → les personnages PRINCIPAUX (les plus fréquents) sont très éloignés sur la roue
// (pas de cyan + bleu ciel, ni jaune + orange côte à côte). Remplace les couleurs
// existantes (après confirmation).
function genererCouleursPersos() {
  if (!etat.persos || !etat.persos.nommes || !etat.persos.nommes.length) return;
  const hsls = [COUL_PRINCIPAL, COUL_SEC1, COUL_SEC2]
    .filter((c) => /^#/.test(c)).map((c) => { const [r, g, b] = hexVersRgb(c); return rgbVersHsl(r, g, b); });
  const moy = (i, def) => hsls.length ? hsls.reduce((s, a) => s + a[i], 0) / hsls.length : def;
  const S = moy(1, 62), L = moy(2, 55), h0 = Math.random() * 360;   // départ aléatoire
  const OR = 137.508;   // angle d'or : teintes consécutives maximalement espacées
  const persos = etat.persos.nommes.filter((p) => p.count >= 2);
  const couleurs = {};
  persos.forEach((p, i) => { couleurs[p.cle] = hslVersHex(h0 + i * OR, S, L); });
  // Tiers : une teinte générique discrète, masculin = féminin (modifiable ensuite).
  const cTiers = hslVersHex(h0 + persos.length * OR, S * 0.55, L);
  couleurs["tiers-f"] = cTiers;
  couleurs["tiers-m"] = cTiers;
  etat.couleursPersonnages = couleurs;
  try { localStorage.setItem("bookreeder-perso-couleurs", JSON.stringify(couleurs)); } catch (e) {}
  if (window.MoteurDialogues && etat.mots && etat.mots.length) window.MoteurDialogues.calculerLocuteurs();
  renderListePersos();
  afficherChunk();
}
// Réinitialiser (Feuille de personnages) : ouvre un menu à 3 choix.
function ouvrirReinit() { $("panneau-reinit").classList.remove("cache"); }
function fermerReinit() { $("panneau-reinit").classList.add("cache"); }
$("btn-reinitialiser")?.addEventListener("click", ouvrirReinit);
$("ri-annuler")?.addEventListener("click", fermerReinit);
$("panneau-reinit")?.addEventListener("click", (e) => { if (e.target === $("panneau-reinit")) fermerReinit(); });
// Réinitialiser les personnages : efface toute la curation (buckets fusionnés /
// séparés / supprimés / noms préférés) → on repart de la détection automatique.
$("ri-persos")?.addEventListener("click", async () => {
  if (!(await confirmer("Réinitialiser les personnages ?\nLes fusions, séparations, suppressions et noms choisis seront effacés, et tous les noms du livre re-détectés (comme à la première ouverture)."))) return;
  etat.persosCuration = {}; sauverCuration();
  etat.persos = null;                       // force une re-détection COMPLÈTE du livre
  fermerReinit();
  appliquerCuration();                      // ré-analyse tout le livre + recalcule + rerender
  if (typeof planifierSauvegardeProfil === "function") planifierSauvegardeProfil();  // persiste la liste fraîche (réouvertures)
});
// Réinitialiser les couleurs : efface les couleurs attribuées (les personnages
// reprennent les couleurs de base de la palette).
$("ri-couleurs")?.addEventListener("click", async () => {
  if (!(await confirmer("Réinitialiser les couleurs ?\nLes couleurs attribuées seront effacées (couleurs de base de la palette restaurées)."))) return;
  etat.couleursPersonnages = {}; sauverCouleursPersos(); fermerReinit();
  if (window.MoteurDialogues && etat.mots && etat.mots.length) window.MoteurDialogues.calculerLocuteurs();
  renderListePersos(); afficherChunk();
});
$("ri-aleatoire")?.addEventListener("click", () => { fermerReinit(); genererCouleursPersos(); });

$("reglage-modele")?.addEventListener("change", (e) => changerModele(e.target.value));
$("reglage-nb-mots").addEventListener("input", (e) => {
  const v = +e.target.value;
  etat.modeStrict = (v === 0);            // « 1 (strict) » : 1 mot, sans groupage nom propre
  etat.nbMots = etat.modeStrict ? 1 : v;
  $("valeur-nb-mots").textContent = etat.modeStrict ? "1 (strict)" : etat.nbMots;
  ajusterCadre();
  afficherChunk();
});

// Largeur du cartouche calculée automatiquement selon le nombre de mots
// affichés (1 à 3) : plus il y a de mots, plus le cadre est large, pour que
// tout tienne sans déborder. La police s'ajuste ensuite si besoin (garde-fou).
function ajusterCadre() {
  const n = etat.nbMots;
  document.documentElement.style.setProperty(
    "--cadre-largeur",
    `min(${88 + n * 2}%, ${440 + n * 140}px)`
  );
}
// Effets de dialogue (élocution / multicolore / italique / fondu), mémorisés.
function appliquerDialogues(val) {
  // « italique » a été retiré des effets : on le filtre (anciennes valeurs enregistrées).
  etat.dialoguesEffets = (val || "").split(",").map((s) => s.trim()).filter((s) => s && s !== "aucun" && s !== "italique");
  const canon = etat.dialoguesEffets.length ? etat.dialoguesEffets.join(",") : "aucun";
  document.querySelectorAll(".dd-effet-select").forEach((s) => { s.value = canon; });   // synchro Feuille ⇄ Réglages
  try { localStorage.setItem("bookreeder-dialogues", canon); } catch (e) {}
  const rendre = () => { if (!ecranLecture.classList.contains("cache")) afficherChunk(); };
  if (besoinMoteurDialogues()) {
    // Multicolore/Élocution : charge le moteur (dialogues.js) au besoin, puis
    // calcule les couleurs (multicolore) et réaffiche.
    const fini = () => {
      if (effetDialogue("multicolore") && window.MoteurDialogues && etat.mots.length) window.MoteurDialogues.calculerLocuteurs();
      rendre();
    };
    if (window.MoteurDialogues) fini(); else chargerMoteurDialogues(fini);
  } else {
    rendre();
  }
}
document.querySelectorAll(".dd-effet-select").forEach((s) => s.addEventListener("change", (e) => appliquerDialogues(e.target.value)));
(function initDialogues() {
  let v = "aucun";
  try { v = localStorage.getItem("bookreeder-dialogues") || "aucun"; } catch (e) {}
  appliquerDialogues(v);
})();
$("reglage-continuer").addEventListener("change", (e) => {
  // Case « Pause après retour / avance rapide » : cochée = on NE continue PAS.
  etat.continuerApresSaut = !e.target.checked;
});
// Pause automatique : "fin" (fin de chapitre) | "suivant" (ouverture du suivant) | "off"
function appliquerPauseAuto(v) {
  etat.pauseAuto = v;
  $("reglage-pause-auto").value = v;
  try { localStorage.setItem("bookreeder-pause-auto", v); } catch (e) {}
}
$("reglage-pause-auto").addEventListener("change", (e) => appliquerPauseAuto(e.target.value));
(function initPauseAuto() {
  let v = "fin";
  try { v = localStorage.getItem("bookreeder-pause-auto") || "fin"; } catch (e) {}
  appliquerPauseAuto(v);
})();

// --- Thème (Midnight / Dark Mono / Sepia / Deep Black) ---
const COULEURS_THEME = { midnight: "#1e1e2e", mono: "#121212", sepia: "#f4ecd8", black: "#000000" };
const COULEURS_PREDEF = ["#ffffff", "rgba(255,255,255,0.75)", "#efe3c8", "rgba(0,0,0,0.9)", "rgba(0,0,0,0.7)"];
let themeActuel = "midnight";
function appliquerTheme(nom) {
  themeActuel = nom;
  document.documentElement.classList.toggle("theme-mono", nom === "mono");
  document.documentElement.classList.toggle("theme-sepia", nom === "sepia");
  document.documentElement.classList.toggle("theme-black", nom === "black");
  $("reglage-theme").value = nom;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", COULEURS_THEME[nom] || COULEURS_THEME.midnight);
  try { localStorage.setItem("bookreeder-theme", nom); } catch (e) {}
  chargerCouleurPoliceDuTheme();   // chaque thème mémorise sa couleur de police
  // La palette est indépendante du thème de fond : on la réapplique avec son thème
  // SOURCE mémorisé (seule « Accentuation » se recalcule, car liée à la couleur d'accent).
  // On n'agit QUE si la palette est déjà initialisée (sinon on écraserait le choix
  // mémorisé pendant l'init, car appliquerTheme tourne avant initPaletteDialogue).
  if (typeof appliquerPaletteDialogue === "function" && etat.paletteDialogue)
    appliquerPaletteDialogue(etat.paletteDialogue, etat.paletteTheme || undefined);
}
$("reglage-theme").addEventListener("change", (e) => appliquerTheme(e.target.value));
(function initTheme() {
  let t = "midnight";
  try { t = localStorage.getItem("bookreeder-theme") || "midnight"; } catch (e) {}
  appliquerTheme(t);
})();
// Palette des dialogues : restaurée au démarrage (après le thème).
(function initPaletteDialogue() {
  try {
    const cp = JSON.parse(localStorage.getItem("bookreeder-perso-voix") || "null");
    if (Array.isArray(cp) && cp.length === 3) couleursPerso = cp;
  } catch (e) {}
  // Synchronise les 3 roues avec les couleurs perso mémorisées.
  ["voix1-couleur", "voix2-couleur", "voix3-couleur"].forEach((id, i) => { if ($(id)) $(id).value = couleursPerso[i]; });
  let nom = "Corail", theme = "";
  try {
    nom = localStorage.getItem("bookreeder-palette-dialogue") || "Corail";
    theme = localStorage.getItem("bookreeder-palette-theme") || "";
  } catch (e) {}
  appliquerPaletteDialogue(nom, theme || undefined);
})();
$("reglage-afficher-mots").addEventListener("change", (e) => {
  etat.afficherMots = e.target.checked;
  $("bloc-nb-mots").style.display = e.target.checked ? "block" : "none";
  majProgression();
});
// Afficher les infos de lecture (position · chapitre · mots) en Mode Minimaliste
$("reglage-infos-minimal").addEventListener("change", (e) => {
  etat.infosMinimal = e.target.checked;
  ecranLecture.classList.toggle("infos-min", e.target.checked);
  try { localStorage.setItem("bookreeder-infos-minimal", e.target.checked ? "1" : "0"); } catch (err) {}
});
(function initInfosMinimal() {
  let on = false;
  try { on = localStorage.getItem("bookreeder-infos-minimal") === "1"; } catch (e) {}
  $("reglage-infos-minimal").checked = on;
  etat.infosMinimal = on;
  ecranLecture.classList.toggle("infos-min", on);
})();
// Pause à la sortie du Mode Loupe : si activé, fermer la loupe (appui simple sur
// play) NE relance PAS la lecture rapide (elle reste en pause).
$("reglage-pause-loupe").addEventListener("change", (e) => {
  etat.pauseLoupe = e.target.checked;
  try { localStorage.setItem("bookreeder-pause-loupe", e.target.checked ? "1" : "0"); } catch (err) {}
});
(function initPauseLoupe() {
  let on = false;
  try { on = localStorage.getItem("bookreeder-pause-loupe") === "1"; } catch (e) {}
  $("reglage-pause-loupe").checked = on;
  etat.pauseLoupe = on;
})();
// Marqueur d'annotations en lecture rapide. Chaque entrée : caractère affiché +
// `accent` (true → couleur d'accentuation en cours, sinon couleur de la police).
// « aucun » = pas de marqueur (car vide).
const MARQUEURS = {
  aucun:          { car: "",  accent: false },
  etoile:         { car: "*", accent: false },
  bulle:          { car: "°", accent: false },
  chapeau:        { car: "^", accent: false },
  hashtag:        { car: "#", accent: false },
  point:          { car: "•", accent: false },
  "etoile-acc":   { car: "*", accent: true },
  "bulle-acc":    { car: "°", accent: true },
  "chapeau-acc":  { car: "^", accent: true },
  "hashtag-acc":  { car: "#", accent: true },
  "point-acc":    { car: "•", accent: true },
};
function appliquerMarqueurNote(v) {
  if (!(v in MARQUEURS)) v = "etoile";
  etat.marqueurNote = v;
  $("reglage-marqueur-note").value = v;
  try { localStorage.setItem("bookreeder-marqueur-note", v); } catch (e) {}
  if (!ecranLecture.classList.contains("cache")) afficherChunk();  // mise à jour immédiate
}
$("reglage-marqueur-note").addEventListener("change", (e) => appliquerMarqueurNote(e.target.value));
(function initMarqueurNote() {
  let v = "etoile";
  try { v = localStorage.getItem("bookreeder-marqueur-note") || "etoile"; } catch (e) {}
  appliquerMarqueurNote(v);
})();

// --- Couleur de la police (cases : Blanc 100/75 %, Crème, Noir 70/90 %, Perso) ---
// La couleur est mémorisée PAR THÈME (clé bookreeder-couleur-police-<thème>).
// Défaut : Sepia → #874e36, autres thèmes → couleur de texte de base (aucune surcharge).
function appliquerCouleurPolice(c, sansSauver) {
  if (!c) return;
  const perso = !COULEURS_PREDEF.includes(c);
  document.documentElement.style.setProperty("--couleur-police", c);
  document.querySelectorAll(".case-couleur:not(.case-perso)").forEach((b) => {
    b.classList.toggle("active", b.dataset.couleur === c);
  });
  const casePerso = document.querySelector(".case-perso");
  if (casePerso) casePerso.classList.toggle("active", perso);
  if (perso && casePerso) {           // la case « Perso » affiche la couleur choisie
    casePerso.style.backgroundImage = "none";
    casePerso.style.background = c;
    $("couleur-police-perso").value = /^#/.test(c) ? c : "#ffcc66";
  }
  if (!sansSauver) {
    try { localStorage.setItem("bookreeder-couleur-police-" + themeActuel, c); } catch (e) {}
  }
}
// Revient à la couleur de base du thème (pas de surcharge) + cases désélectionnées.
function effacerCouleurPolice() {
  document.documentElement.style.removeProperty("--couleur-police");
  document.querySelectorAll(".case-couleur").forEach((b) => b.classList.remove("active"));
  const casePerso = document.querySelector(".case-perso");
  if (casePerso) { casePerso.style.background = ""; casePerso.style.backgroundImage = ""; }
}
// Charge la couleur mémorisée du thème courant, sinon son défaut.
function chargerCouleurPoliceDuTheme() {
  let c = null;
  try { c = localStorage.getItem("bookreeder-couleur-police-" + themeActuel); } catch (e) {}
  if (!c) c = (themeActuel === "sepia") ? "#874e36" : null;
  if (c) appliquerCouleurPolice(c, true);
  else effacerCouleurPolice();
}
document.querySelectorAll("#couleurs-police .case-couleur:not(.case-perso)").forEach((b) => {
  b.addEventListener("click", () => appliquerCouleurPolice(b.dataset.couleur));
});
$("couleur-police-perso").addEventListener("input", (e) => appliquerCouleurPolice(e.target.value));

// --- Longueur des pauses (coefficient multiplicateur) ---
// --- Page 4/4 : facteurs de rythme du modèle BookReeder (réglage fin) ---
// Chaque facteur multiplie la durée d'un mot (× base). Persisté par livre (profil)
// via les clés bookreeder-fact-*. Les coefs de la page 1 (coefPause, coefDialogue)
// s'appliquent PAR-DESSUS ces valeurs de base.
const FACTEURS_RYTHME = [
  { id: "finphrase",  param: "pauseFinPhrase",   def: 1.5 },
  { id: "virgule",    param: "pauseVirgule",     def: 1.0 },
  { id: "paragraphe", param: "pauseParagraphe",  def: 1.5 },
  { id: "replique",   param: "pauseReplique",    def: 1.0 },
  { id: "plancher",   param: "motMin",           def: 0.6 },
  { id: "dialogue",   param: "plancherDialogue", def: 1.0 },
  { id: "nompropre",  param: "nomPropreFact",    def: 2.5 },
  { id: "elan",       param: "elanGrossePause",  def: 0.65 },
];
function fmtFacteur(v) { let s = (+v).toFixed(2); if (s.endsWith("0")) s = s.slice(0, -1); return "× " + s.replace(".", ","); }
function appliquerFacteursRythme() {
  FACTEURS_RYTHME.forEach((f) => {
    let v = f.def;
    try { const s = localStorage.getItem("bookreeder-fact-" + f.id); if (s != null && isFinite(+s)) v = +s; } catch (e) {}
    MODELES.default.params[f.param] = v;
    const sl = $("fact-" + f.id); if (sl) sl.value = v;
    const lab = $("val-" + f.id); if (lab) lab.textContent = fmtFacteur(v);
  });
}
FACTEURS_RYTHME.forEach((f) => {
  const sl = $("fact-" + f.id); if (!sl) return;
  sl.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    MODELES.default.params[f.param] = v;
    const lab = $("val-" + f.id); if (lab) lab.textContent = fmtFacteur(v);
    try { localStorage.setItem("bookreeder-fact-" + f.id, String(v)); } catch (er) {}
    majDureeChapitre();
    if (!ecranLecture.classList.contains("cache")) afficherChunk();
  });
});
appliquerFacteursRythme();

// --- Répartition du texte en Mode Loupe (dropdown Réglages 1/4) ---
const LOUPE_TEXTE = {
  "defaut":           ["txt-gauche"],
  "cesure-lettres":   ["txt-cesures", "txt-lettres"],
  "cesure-mots":      ["txt-cesures", "txt-mots"],
  "nocesure-lettres": ["txt-lettres"],
  "nocesure-mots":    ["txt-mots"],
};
function appliquerLoupeTexte(v) {
  if (!(v in LOUPE_TEXTE)) v = "defaut";
  const el = $("contexte-texte");
  if (el) {
    el.classList.remove("txt-gauche", "txt-cesures", "txt-mots", "txt-lettres");
    LOUPE_TEXTE[v].forEach((c) => el.classList.add(c));
  }
  const sel = $("reglage-loupe-texte"); if (sel) sel.value = v;
  try { localStorage.setItem("bookreeder-loupe-texte", v); } catch (e) {}
}
$("reglage-loupe-texte")?.addEventListener("change", (e) => appliquerLoupeTexte(e.target.value));
(function initLoupeTexte() {
  let v = "defaut";
  try { v = localStorage.getItem("bookreeder-loupe-texte") || "defaut"; } catch (e) {}
  appliquerLoupeTexte(v);
})();

function appliquerCoefPause(v) {
  etat.coefPause = v;
  $("reglage-pauses").value = v;
  $("valeur-pauses").textContent = v <= 0 ? "aucune" : "x " + v.toFixed(1).replace(".", ",");
  try { localStorage.setItem("bookreeder-coef-pause", v); } catch (e) {}
}
$("reglage-pauses").addEventListener("input", (e) => appliquerCoefPause(+e.target.value));
(function initCoefPause() {
  let v = 2;
  try { const s = localStorage.getItem("bookreeder-coef-pause"); if (s) v = +s; } catch (e) {}
  appliquerCoefPause(v);
})();

// --- Ralentissement des dialogues (×1 à ×2, défaut ×1,3) ---
function appliquerCoefDialogue(v) {
  etat.coefDialogue = v;
  $("reglage-dialogue-lent").value = v;
  $("valeur-dialogue-lent").textContent = v <= 1 ? "aucun" : "x " + v.toFixed(1).replace(".", ",");
  try { localStorage.setItem("bookreeder-coef-dialogue", v); } catch (e) {}
}
$("reglage-dialogue-lent").addEventListener("input", (e) => appliquerCoefDialogue(+e.target.value));
(function initCoefDialogue() {
  let v = 1.3;
  try { const s = localStorage.getItem("bookreeder-coef-dialogue"); if (s) v = +s; } catch (e) {}
  appliquerCoefDialogue(v);
})();

// --- Élan à la reprise (0 = aucun, ×1 ≈ 10 mots, ×3 ≈ 30 mots) ---
function appliquerCoefElan(v) {
  etat.coefElan = v;
  $("reglage-elan").value = v;
  $("valeur-elan").textContent = v <= 0 ? "aucun" : Math.round(v * 10) + " mots";
  try { localStorage.setItem("bookreeder-coef-elan", v); } catch (e) {}
}
$("reglage-elan").addEventListener("input", (e) => appliquerCoefElan(+e.target.value));
(function initCoefElan() {
  let v = 1;
  try { const s = localStorage.getItem("bookreeder-coef-elan"); if (s != null && s !== "") v = +s; } catch (e) {}
  if (!isFinite(v) || v < 0 || v > 3) v = 1;
  appliquerCoefElan(v);
})();

// --- Accélération (expérimental) : panneau ouvert en touchant l'info de vitesse ---
function appliquerCoefAccel(v) {
  etat.coefAccel = v;
  $("reglage-accel").value = v;
  $("valeur-accel").textContent = (+v <= 1 ? "1,0 (désactivé)" : (+v).toFixed(1).replace(".", ","));
  $("btn-fermer-accel").textContent = (+v <= 1 ? "OK" : (+v >= 3 ? "T'es ouf !" : "Zé partiii !"));
  try { localStorage.setItem("bookreeder-coef-accel", v); } catch (e) {}
  majVitesseAffichee();   // accent à jour immédiatement (coef ≠ ×1)
  demarrerAccel();
}
$("reglage-accel").addEventListener("input", (e) => appliquerCoefAccel(+e.target.value));
(function initCoefAccel() {
  let v = 1;
  try { const s = localStorage.getItem("bookreeder-coef-accel"); if (s) v = +s; } catch (e) {}
  if (!isFinite(v) || v < 1 || v > 3) v = 1;
  appliquerCoefAccel(v);
})();
// Intervalle entre deux hausses d'accélération (5/10/20/30/60 s)
const PALIERS_ACCEL = [5, 10, 20, 30, 60];   // paliers (s) du slider d'intervalle
function appliquerIntervalleAccel(sec) {
  if (!PALIERS_ACCEL.includes(sec)) sec = 10;
  etat.intervalleAccel = sec;
  $("reglage-accel-intervalle").value = PALIERS_ACCEL.indexOf(sec);
  $("valeur-accel-intervalle").textContent = sec;
  try { localStorage.setItem("bookreeder-accel-intervalle", sec); } catch (e) {}
  demarrerAccel();   // applique le nouvel intervalle si on lit
}
$("reglage-accel-intervalle").addEventListener("input", (e) => {
  appliquerIntervalleAccel(PALIERS_ACCEL[+e.target.value] || 10);
});
(function initIntervalleAccel() {
  let v = 10;
  try { const s = localStorage.getItem("bookreeder-accel-intervalle"); if (s) v = +s; } catch (e) {}
  appliquerIntervalleAccel(v);
})();
$("info-vitesse").addEventListener("click", () => {
  pause();                       // on arrête la lecture pendant le réglage
  $("panneau-accel").classList.remove("cache");
});
$("btn-fermer-accel").addEventListener("click", () => $("panneau-accel").classList.add("cache"));
$("reglage-orp").addEventListener("change", (e) => {
  etat.orpActif = e.target.checked;
  majVisibiliteOrpCouleur();
  appliquerOrp();
  afficherChunk();
});
// La couleur du repère ne s'affiche que si « Repère central » est coché
function majVisibiliteOrpCouleur() {
  // La couleur d'accentuation reste toujours visible : elle sert aussi aux
  // dialogues colorés et aux marqueurs d'annotation, indépendamment du repère.
  $("bloc-orp-couleur").style.display = "flex";
}

// --- Police : 2 menus (famille + variante) ---
// CSS de chaque famille « normale »
const FAMILLE_CSS = {
  georgia:  'Georgia, "Times New Roman", serif',
  merri:    '"Merriweather", Georgia, serif',
  mono:     'ui-monospace, "Courier New", monospace',
  roboto:   '"Roboto", sans-serif',
  literata: '"Literata", Georgia, serif',
  noto:     '"Noto Sans", sans-serif',
  dejavu:   '"DejaVu Sans", sans-serif',
  dys:      '"OpenDyslexic", sans-serif',
};
// Familles proposées + leurs variantes (poids, ou police de base pour Bionic)
const POIDS = [{ id: "300", nom: "Léger" }, { id: "400", nom: "Normal" },
               { id: "700", nom: "Gras" }, { id: "900", nom: "Black" }];
const wn = [POIDS[1], POIDS[2]]; // Normal / Gras
const FAMILLES = [
  { id: "georgia",  nom: "Georgia",       variantes: wn },
  { id: "merri",    nom: "Merriweather",  variantes: POIDS },
  { id: "mono",     nom: "Monospace",     variantes: wn },
  { id: "roboto",   nom: "Roboto",        variantes: wn },
  { id: "literata", nom: "Literata",      variantes: wn },
  { id: "noto",     nom: "Noto Sans",     variantes: wn },
  { id: "dejavu",   nom: "DejaVu Sans",   variantes: wn },
  { id: "dys",      nom: "Open Dyslexic", variantes: wn },
  { id: "bionic",   nom: "Bionic",        variantes: [
      { id: "georgia", nom: "Georgia" }, { id: "roboto", nom: "Roboto" }] },
];
const variantesDe = (id) => (FAMILLES.find((f) => f.id === id) || FAMILLES[0]).variantes;

function appliquerPolice() {
  const fam = $("reglage-police").value;
  const varr = $("reglage-variante").value;
  let police, graisse, bionic;
  if (fam === "bionic") {
    police = FAMILLE_CSS[varr] || FAMILLE_CSS.georgia;
    graisse = 400; bionic = true;
  } else {
    police = FAMILLE_CSS[fam] || FAMILLE_CSS.georgia;
    graisse = +varr || 400; bionic = false;   // « maj » → NaN → 400 (poids normal)
  }
  // Variante « MAJUSCULE » : affiche le mot en capitales
  motAffiche.classList.toggle("majuscules", varr === "maj");
  document.documentElement.style.setProperty("--police", police);
  document.documentElement.style.setProperty("--graisse", graisse);
  etat.bionic = bionic;
  // La couleur du début bionic ne s'affiche que si le bionic est choisi
  $("bloc-bionic-couleur").style.display = bionic ? "flex" : "none";
  $("bloc-bionic-perso").style.display =
    (bionic && $("reglage-bionic-couleur").value === "perso") ? "flex" : "none";
}

// (Re)remplit le menu Variantes selon la famille choisie ; défaut = Normal.
// Une variante spéciale « MAJUSCULE » (sauf en Bionic) affiche le texte en capitales.
function remplirVariantes(familleId) {
  const sel = $("reglage-variante");
  const vs = variantesDe(familleId);
  sel.innerHTML = "";
  vs.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.id; o.textContent = v.nom; sel.appendChild(o);
  });
  if (familleId !== "bionic") {
    const o = document.createElement("option");
    o.value = "maj"; o.textContent = "MAJUSCULE"; sel.appendChild(o);
  }
  sel.value = vs.some((v) => v.id === "400") ? "400" : vs[0].id;
}

function initialiserPolices() {
  const selP = $("reglage-police");
  selP.innerHTML = "";
  FAMILLES.forEach((f) => {
    const o = document.createElement("option");
    o.value = f.id; o.textContent = f.nom; selP.appendChild(o);
  });
  selP.value = "georgia";
  remplirVariantes("georgia");
  appliquerPolice();
}
$("reglage-police").addEventListener("change", () => {
  remplirVariantes($("reglage-police").value);
  appliquerPolice();
  afficherChunk();
});
$("reglage-variante").addEventListener("change", () => {
  appliquerPolice();
  afficherChunk();
});
initialiserPolices();

// --- Couleur du début bionic ---
function appliquerBioCouleur() {
  const choix = $("reglage-bionic-couleur").value;
  let couleur;
  if (choix === "uniforme") couleur = "inherit";
  else if (choix === "perso") couleur = $("reglage-bio-teinte").value;
  else couleur = choix; // valeur hex d'un préréglage
  document.documentElement.style.setProperty("--bio-couleur", couleur);
}

$("reglage-bionic-couleur").addEventListener("change", (e) => {
  $("bloc-bionic-perso").style.display = e.target.value === "perso" ? "flex" : "none";
  appliquerBioCouleur();
});
$("reglage-bio-teinte").addEventListener("input", appliquerBioCouleur);

// --- Couleur d'accentuation (lettre ORP) — pastilles de couleur ---
const COULEURS_ORP_PREDEF = ["#f25c54", "#a6de7a", "#ffd359"];
// `choix` : "aucune", un préréglage hex, "perso" (lit la roue), ou un hex perso.
function appliquerOrpCouleur(choix, sansSauver) {
  if (choix == null) choix = "#f25c54";
  if (choix === "perso") choix = $("reglage-orp-teinte").value;
  const aucune = choix === "aucune";
  const couleur = aucune ? "currentColor" : choix;       // « aucune » = couleur du texte
  const perso = !aucune && !COULEURS_ORP_PREDEF.includes(choix);
  document.documentElement.style.setProperty("--orp-couleur", couleur);
  // Surligne la pastille active
  document.querySelectorAll("#couleurs-orp .case-couleur:not(.case-perso)").forEach((b) => {
    b.classList.toggle("active", b.dataset.couleur === (aucune ? "aucune" : choix));
  });
  const casePerso = document.querySelector("#couleurs-orp .case-perso");
  if (casePerso) {
    casePerso.classList.toggle("active", perso);
    if (perso) { casePerso.style.backgroundImage = "none"; casePerso.style.background = choix; }
    else { casePerso.style.background = ""; casePerso.style.backgroundImage = ""; }
  }
  if (perso && /^#/.test(choix)) $("reglage-orp-teinte").value = choix;
  if (!sansSauver) {
    try {
      localStorage.setItem("bookreeder-orp-couleur", perso ? "perso" : choix);
      localStorage.setItem("bookreeder-orp-teinte", $("reglage-orp-teinte").value);
    } catch (e) {}
  }
  colorerOptionsMarqueur(couleur);
  // Si la palette de dialogue « Accentuation » est active, elle dérive de cette
  // couleur → on la recalcule pour qu'elle suive le nouveau choix.
  if (etat.paletteDialogue === "Accentuation" && typeof appliquerPaletteDialogue === "function") {
    appliquerPaletteDialogue("Accentuation");
  }
}
// Affiche les options « accentuées » du menu marqueur dans la couleur
// d'accentuation en cours (« aucune » → couleur du texte).
function colorerOptionsMarqueur(couleur) {
  const c = (couleur === "currentColor") ? "" : couleur;
  document.querySelectorAll("#reglage-marqueur-note .opt-accent")
    .forEach((o) => { o.style.color = c; });
}
document.querySelectorAll("#couleurs-orp .case-couleur:not(.case-perso)").forEach((b) => {
  b.addEventListener("click", () => appliquerOrpCouleur(b.dataset.couleur));
});
$("reglage-orp-teinte").addEventListener("input", (e) => appliquerOrpCouleur(e.target.value));
function initialiserOrpCouleur() {
  let c = "#f25c54";
  try {
    const sc = localStorage.getItem("bookreeder-orp-couleur");
    const st = localStorage.getItem("bookreeder-orp-teinte");
    if (st) $("reglage-orp-teinte").value = st;
    if (sc) c = sc;
  } catch (e) {}
  appliquerOrpCouleur(c, true);
  majVisibiliteOrpCouleur();
}
initialiserOrpCouleur();

$("reglage-majuscules")?.addEventListener("change", (e) => {
  motAffiche.classList.toggle("majuscules", e.target.checked);
  afficherChunk(); // recalcule le centrage ORP (largeurs modifiées)
});
$("reglage-taille-police").addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--echelle-police", e.target.value / 100);
  $("valeur-taille-police").textContent = e.target.value;
  afficherChunk(); // recalcule l'ajustement au cadre + centrage ORP
});
// Taille de la police du Mode Loupe (50–200 %, 100 % = taille du titre, mémorisée)
function appliquerTailleLoupe(v) {
  document.documentElement.style.setProperty("--echelle-loupe", v / 100);
  $("reglage-taille-loupe").value = v;
  $("valeur-taille-loupe").textContent = v;
  try { localStorage.setItem("bookreeder-taille-loupe", v); } catch (e) {}
}
$("reglage-taille-loupe").addEventListener("input", (e) => appliquerTailleLoupe(+e.target.value));
(function initTailleLoupe() {
  let v = 100;
  try { const s = localStorage.getItem("bookreeder-taille-loupe"); if (s) v = +s; } catch (e) {}
  if (!isFinite(v) || v < 50 || v > 200) v = 100;   // ignore les valeurs hors plage
  appliquerTailleLoupe(v);
})();
// Assombrissement du texte atténué en Mode Loupe : 0 % = aucun (opacité 1),
// 100 % = invisible (opacité 0). Opacité = 1 − dim%/100. Défaut 50 %.
function appliquerDimLoupe(v) {
  document.documentElement.style.setProperty("--dim-loupe", (1 - v / 100).toString());
  // À 100 % (texte invisible), en lecture auto Loupe on garde la PHRASE en cours
  // lisible (50 %) avec le mot courant en couleur d'accentuation — sinon il ne
  // resterait que le mot et la phrase disparaîtrait.
  $("ecran-contexte").classList.toggle("dim-max", +v >= 100);
  $("reglage-dim-loupe").value = v;
  $("valeur-dim-loupe").textContent = v;
  try { localStorage.setItem("bookreeder-dim-loupe", v); } catch (e) {}
}
$("reglage-dim-loupe").addEventListener("input", (e) => appliquerDimLoupe(+e.target.value));
(function initDimLoupe() {
  let v = 50;
  try { const s = localStorage.getItem("bookreeder-dim-loupe"); if (s != null && s !== "") v = +s; } catch (e) {}
  if (!isFinite(v) || v < 0 || v > 100) v = 50;
  appliquerDimLoupe(v);
})();
// « Ralenti sur noms propres » : valeur « off » ou « <mult>-<mode> » (ex. « 3-once »,
// « 2-tous »). mult = 2/3/4 ; mode = once (1ʳᵉ apparition) / tous (à chaque fois).
function appliquerRalentiNom(v) {
  const m = /^(\d)-(once|tous)$/.exec(v || "");
  etat.ralentiNomMult = m ? +m[1] : 0;
  etat.ralentiNomMode = m ? m[2] : "tous";
  etat.nomsRalentis = new Set();                 // réinitialise les « déjà vus »
  if ($("reglage-ralenti-nom")) $("reglage-ralenti-nom").value = (etat.ralentiNomMult > 1) ? v : "off";
  try { localStorage.setItem("bookreeder-ralenti-nom", v || "off"); } catch (e) {}
}
$("reglage-ralenti-nom").addEventListener("change", (e) => appliquerRalentiNom(e.target.value));
(function initRalentiNom() {
  let v = "off";
  try { const s = localStorage.getItem("bookreeder-ralenti-nom"); if (s) v = s; } catch (e) {}
  appliquerRalentiNom(v);
})();
$("reglage-espace-lettres").addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--espace-lettres", e.target.value + "px");
  $("valeur-espace-lettres").textContent = e.target.value;
  afficherChunk();
});
$("reglage-espace-mots").addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--espace-mots", e.target.value + "px");
  $("valeur-espace-mots").textContent = e.target.value;
  afficherChunk();
});
$("reglage-ecart-reperes").addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--ret-ecart", e.target.value + "px");
  $("valeur-ecart-reperes").textContent = e.target.value;
});
$("reglage-long-reperes").addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--ret-longueur", e.target.value + "px");
  $("valeur-long-reperes").textContent = e.target.value;
});
$("reglage-cadre").addEventListener("change", (e) => {
  zoneMot.classList.toggle("avec-cadre", e.target.checked);
});

function appliquerOrp() {
  zoneMot.classList.toggle("sans-orp", !etat.orpActif);
  motAffiche.classList.toggle("sans-orp", !etat.orpActif);
}

// Raccourcis clavier (PC/Mac)
document.addEventListener("keydown", (e) => {
  if (ecranLecture.classList.contains("cache")) return;
  if (e.code === "Space") { e.preventDefault(); basculerLecture(); }
  else if (e.code === "ArrowLeft") deplacer(phrasePrecedente() - etat.index, true);
  else if (e.code === "ArrowRight") deplacer(phraseSuivante() - etat.index, true);
});

// Toucher le cartouche = bascule l'affichage épuré (« fullscreen »)
zoneMot.addEventListener("click", () => {
  // En paysage, l'écran principal complet n'est pas autorisé : on reste en minimaliste.
  if (window.matchMedia("(orientation: landscape)").matches
      && ecranLecture.classList.contains("epure")) return;
  ecranLecture.classList.toggle("epure");
  afficherChunk(); // recentre l'ORP (largeur dispo modifiée)
});

// Boutons recul / avance (normal ET épuré) : appui COURT = un mot ; appui LONG
// (≈0,5 s) = phrase par phrase (comme les anciens boutons de phrase). Après le
// saut, on montre l'annotation du mot si on est en pause (cf. majAnnotationMinimal).
function installerNavMotPhrase(id, sens) {
  const btn = $(id);
  if (!btn) return;
  let timer = null, long = false;
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(() => {
      long = true;
      const cible = sens < 0 ? phrasePrecedente() : phraseSuivante();
      deplacer(cible - etat.index, true);
      majAnnotationMinimal();
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
  btn.addEventListener("click", () => {
    if (long) { long = false; return; }   // l'appui long a déjà agi
    deplacer(sens, true);                  // appui court = un mot
    majAnnotationMinimal();
  });
}
installerNavMotPhrase("btn-recul", -1);
installerNavMotPhrase("btn-avance", +1);
installerNavMotPhrase("ep-recul", -1);
installerNavMotPhrase("ep-avance", +1);
installerPlayLong("ep-lecture");

// --- Orientation paysage : autorisée seulement en Mode Loupe & Mode Minimaliste.
// Sur l'écran principal, le passage en paysage bascule en Mode Minimaliste. ---
const mqPaysage = window.matchMedia("(orientation: landscape)");
let epureForceePaysage = false;
function gererOrientation() {
  const paysage = mqPaysage.matches;
  const lectureVisible = !ecranLecture.classList.contains("cache");
  const enLoupe = !$("ecran-contexte").classList.contains("cache");
  if (paysage && lectureVisible && !enLoupe && !ecranLecture.classList.contains("epure")) {
    ecranLecture.classList.add("epure");        // écran principal interdit en paysage
    epureForceePaysage = true;
    afficherChunk();
  } else if (!paysage && epureForceePaysage && ecranLecture.classList.contains("epure")) {
    ecranLecture.classList.remove("epure");     // retour portrait : on revient à l'écran principal
    epureForceePaysage = false;
    afficherChunk();
  }
  majZonesTap();
}
mqPaysage.addEventListener("change", gererOrientation);
gererOrientation();

// --- Mode Minimaliste paysage : contrôle tactile par zones gauche/droite ---
// Le mode est actif uniquement en Minimaliste (epure) + paysage + hors Loupe.
function modeMinimalActif() {
  return ecranLecture.classList.contains("epure") && mqPaysage.matches
    && !ecranLecture.classList.contains("cache")
    && $("ecran-contexte").classList.contains("cache");
}
// Affiche/masque les deux zones tactiles selon le mode.
function majZonesTap() {
  const z = $("zones-tap-min");
  if (!z) return;
  const actif = modeMinimalActif();
  z.classList.toggle("cache", !actif);
  if (!actif) { const n = $("note-min"); if (n) n.classList.add("cache"); }
}
// Annotation flottante : visible seulement à la PAUSE, en Minimaliste, si le mot
// courant porte une note (exposant). Masquée dès la reprise de lecture.
function majAnnotationMinimal() {
  const el = $("note-min");
  if (!el) return;
  // Visible dans TOUS les modes de lecture (normal/minimaliste, portrait/paysage),
  // sauf en Mode Loupe, quand on est EN PAUSE sur un mot porteur d'une note.
  const actif = !ecranLecture.classList.contains("cache")
    && $("ecran-contexte").classList.contains("cache")    // pas en Mode Loupe
    && !etat.enLecture
    && etat.noteParMot && etat.noteParMot.has(etat.index);
  if (!actif) { el.classList.add("cache"); return; }
  const notes = etat.noteParMot.get(etat.index) || [];
  el.innerHTML = notes.map((n) =>
    `<p><b>${echHtml(n.num)}.</b> ${n.texte ? echHtml(n.texte) : "<i>(annotation introuvable)</i>"}</p>`
  ).join("");
  el.classList.remove("cache");
  // Positionne sous le cartouche du mot, recadré dans l'écran.
  const z = $("zone-mot").getBoundingClientRect();
  const bb = el.getBoundingClientRect();
  let top = z.bottom + 12;
  if (top + bb.height > window.innerHeight - 8) top = Math.max(8, z.top - 12 - bb.height);
  el.style.top = top + "px";
  el.style.left = "50%";
  el.style.transform = "translateX(-50%)";
}
// Avance/recule d'UN mot (déjà en pause), puis montre la note du nouveau mot.
function zoneMotMinimal(sens) {
  if (!etat.mots.length) return;
  etat.index = Math.min(etat.mots.length - 1, Math.max(0, etat.index + sens));
  afficherChunk();
  sauverPosition();
  majAnnotationMinimal();
}
// Appui long sur une zone latérale : navigation phrase par phrase (déjà en pause).
function zonePhraseMinimal(sens) {
  if (!etat.mots.length) return;
  const cible = sens < 0 ? phrasePrecedente() : phraseSuivante();
  deplacer(cible - etat.index, false);   // false = on reste en pause à la nouvelle position
  majAnnotationMinimal();
}
// Installe une zone tactile (g/c/d).
//  - Centre : bascule lecture / pause.
//  - Côtés : chaque appui met en pause (si on lit) ET recule/avance d'UN mot —
//    les appuis s'enchaînent ; appui LONG = phrase par phrase.
function installerZoneMin(el, type) {
  if (!el) return;
  if (type === "c") {                       // centre : play / pause
    el.addEventListener("click", () => basculerLecture());
    return;
  }
  const sens = type === "g" ? -1 : 1;
  let timer = null, longFait = false;
  el.addEventListener("pointerdown", () => {
    longFait = false;
    timer = setTimeout(() => {
      longFait = true;
      if (etat.enLecture) pause();
      zonePhraseMinimal(sens);              // appui long = phrase
    }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
    el.addEventListener(ev, () => clearTimeout(timer)));
  el.addEventListener("pointerup", () => {
    if (longFait) { longFait = false; return; }   // l'appui long a déjà agi
    if (etat.enLecture) pause();                   // 1er appui = met en pause ET…
    zoneMotMinimal(sens);                          // …recule/avance d'un mot (chaînable)
  });
}
installerZoneMin($("tap-min-g"), "g");
installerZoneMin($("tap-min-c"), "c");
installerZoneMin($("tap-min-d"), "d");

// PWA : enregistrement du service worker (hors-ligne + mise à jour auto)
let swRegistration = null;
if ("serviceWorker" in navigator) {
  let rechargement = false;
  const avaitControleur = !!navigator.serviceWorker.controller;
  // Quand le nouveau service worker prend la main → on recharge une fois pour
  // basculer sur la nouvelle version (sauf à la toute première visite).
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (rechargement || !avaitControleur) return;
    rechargement = true;
    location.reload();
  });
  navigator.serviceWorker.register("sw.js").then((reg) => {
    swRegistration = reg;
    const verifier = () => reg.update().catch(() => {});
    // Vérification au démarrage : si une nouvelle version va prendre la main (on
    // avait déjà un contrôleur ET un worker s'installe), on laisse la bulle masquée
    // — elle apparaîtra après le rechargement auto. Sinon, on l'autorise.
    reg.update().then(() => {
      if (!(avaitControleur && (reg.installing || reg.waiting))) autoriserBulle();
    }).catch(() => autoriserBulle());
    // …et à chaque fois qu'on revient sur l'onglet / rouvre l'app
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) verifier();
    });
  }).catch(() => autoriserBulle());
}

// Bouton « Vérifier les mises à jour… » du panneau Infos
$("btn-maj").addEventListener("click", async () => {
  const statut = $("statut-maj");
  if (!("serviceWorker" in navigator) || !swRegistration) {
    statut.textContent = "Mises à jour indisponibles ici.";
    return;
  }
  statut.textContent = "Vérification…";
  try {
    await swRegistration.update();
    // Si une nouvelle version est trouvée, elle s'installe puis l'app se
    // rechargera automatiquement (via controllerchange). Sinon : déjà à jour.
    if (swRegistration.installing || swRegistration.waiting) {
      statut.textContent = "Nouvelle version trouvée, mise à jour…";
    } else {
      // Numéro de version + date de dernière mise à jour
      let detail = "";
      const ver = versionApp();
      if (ver) detail = "v" + ver;
      // Date du dernier déploiement (modification du fichier en ligne), sans les secondes
      try {
        const r = await fetch("./app.js?ts=" + Date.now(), { cache: "no-store" });
        const lm = r.headers.get("last-modified");
        if (lm) {
          const d = new Date(lm), p = (n) => String(n).padStart(2, "0");
          const dateStr = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
          detail += (detail ? " - " : "") + dateStr;
        }
      } catch (e) {}
      statut.innerHTML = "Vous avez déjà la dernière version. ✓" + (detail ? "<br>" + detail : "");
    }
  } catch (e) {
    statut.textContent = "Impossible de vérifier (connexion ?).";
  }
});

// =========================================================
//  Persistance des réglages restants (survivent aux mises à jour)
// =========================================================
// Les réglages ci-dessous n'étaient pas mémorisés : ils repartaient par défaut à
// chaque rechargement / mise à jour. On restaure la valeur enregistrée (si elle
// existe — sinon on garde le défaut, pratique pour un réglage NOUVEAU) et on
// sauvegarde à chaque changement. Exécuté en dernier, APRÈS tous les inits, pour
// ne pas être écrasé. L'ordre compte (police avant variante).
const CONFIG_REGLAGES_GENERIQUES = [
  ["reglage-police", "change"],
  ["reglage-variante", "change"],
  ["reglage-nb-mots", "input"],
  ["reglage-continuer", "change"],
  ["reglage-afficher-mots", "change"],
  ["reglage-bionic-couleur", "change"],
  ["reglage-bio-teinte", "input"],
  ["reglage-taille-police", "input"],
  ["reglage-espace-lettres", "input"],
  ["reglage-espace-mots", "input"],
  ["reglage-cadre", "change"],
  ["reglage-orp", "change"],
  ["reglage-ecart-reperes", "input"],
  ["reglage-long-reperes", "input"],
];
// Restaure (valeur + événement) les réglages génériques depuis le stockage
// (profil du livre courant via le shim, sinon global). Réutilisé à l'ouverture.
function restaurerReglagesGeneriques() {
  CONFIG_REGLAGES_GENERIQUES.forEach(([id, evt]) => {
    const el = $(id);
    if (!el) return;
    try {
      const v = localStorage.getItem("bookreeder-" + id);
      if (v !== null) {
        if (el.type === "checkbox") el.checked = (v === "1");
        else el.value = v;
        el.dispatchEvent(new Event(evt, { bubbles: true }));
      }
    } catch (e) {}
  });
}
(function persisterReglages() {
  CONFIG_REGLAGES_GENERIQUES.forEach(([id, evt]) => {
    const el = $(id);
    if (!el) return;
    const cle = "bookreeder-" + id;
    const sauver = () => {
      try {
        localStorage.setItem(cle, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value);
      } catch (e) {}
    };
    el.addEventListener(evt, sauver);
    el.addEventListener("change", sauver);   // filet pour les menus / cases
  });
  restaurerReglagesGeneriques();   // restauration initiale (global au démarrage)
})();
