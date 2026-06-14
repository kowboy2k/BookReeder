// =========================================================
//  Chargeur — construction / nettoyage de la table des matières
// =========================================================
// Première brique du futur module de chargement. Pour l'instant : catégorise les
// sections, coupe les couvertures, nettoie les numéros incohérents, et bâtit la
// table selon le mode choisi (« existante » nettoyée ou « optimisée »).
// Le reste du parsing (EPUB/PDF/TXT) sera migré progressivement.

(function () {
  "use strict";

  // Normalise un titre pour comparaison : sans accents, minuscules (les classes
  // \b de JS ne reconnaissent pas les lettres accentuées → on les retire).
  function norm(t) {
    return (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  // Couvertures (à SUPPRIMER) : 1ʳᵉ / page de garde / 4ᵉ de couverture.
  const RE_COUV = /\b(couverture|page de garde|quatrieme de couv|4e? de couv|back cover|front cover)\b|^cover$/;
  // Ouvertures GARDÉES comme entrées : préface / prologue / introduction.
  const RE_OUVERTURE = /\b(preface|prologue|introduction|foreword)\b/;
  // Épilogue GARDÉ comme entrée.
  const RE_EPILOGUE = /\b(epilogue)\b/;
  // Matière HORS contenu (début ou fin selon la position) : à fusionner.
  const RE_HORS = /\b(copyright|mentions? legales?|page legale|acheve d|depot legal|colophon|ours|dedicace|exergue|epigraphe|preambule|avant[ -]?propos|faux[ -]?titre|page de titre|title page|half[ -]?title|imprint|frontispiece|chronologie|sommaire|table des matieres|postface|glossaire|lexique|bibliographie|annexes?|appendi(x|ce)|a propos|about the author|afterword|credits?|remerciements?|biographie|du meme auteur|also by|dedication|acknowledge?ments?)\b|^(titre|index|notes?)$/;

  function categorie(t) {
    const n = norm(t);
    if (RE_COUV.test(n)) return "couv";
    if (RE_OUVERTURE.test(n)) return "ouverture";
    if (RE_EPILOGUE.test(n)) return "epilogue";
    if (RE_HORS.test(n)) return "hors";
    return "chapitre";
  }

  // Numéro de tête « nu » + séparateur (« 14 · », « 3. »…).
  function numTete(t) { const m = (t || "").trim().match(/^\s*(\d+)\s*[.:·•—–\-)]+/); return m ? parseInt(m[1], 10) : null; }
  // Retire les numéros de tête INCOHÉRENTS (jamais d'ajout). Cohérent = suite
  // croissante majoritaire → on garde ; sinon on retire les préfixes parasites.
  function nettoyer(chaps) {
    const pres = chaps.map((c) => numTete(c.titre)).filter((v) => v != null);
    let croiss = true;
    for (let i = 1; i < pres.length; i++) if (pres[i] <= pres[i - 1]) { croiss = false; break; }
    const coherent = pres.length >= Math.ceil(chaps.length * 0.6) && croiss;
    return chaps.map((c) => {
      let t = c.titre || "";
      if (!coherent && numTete(t) != null) t = t.replace(/^\s*\d+\s*[.:·•—–\-)]+\s*/, "").trim();
      return { titre: t, debut: c.debut };
    });
  }

  // Une vraie table des matières d'origine existe-t-elle ? (sinon, libellés
  // génériques « Section N » / « Passage N » / « Début » issus du repli.)
  function aTOCReelle(chaps) {
    if (!chaps || chaps.length < 2) return false;
    const gen = chaps.filter((c) => {
      const t = (c.titre || "").trim();
      return /^(section|passage)\s+\d+$/i.test(t) || /^d[ée]but$/i.test(t);
    }).length;
    return gen < chaps.length * 0.5;
  }

  // Un « micro-chapitre » = un chapitre numéroté SANS nom (« 2 », « IV »,
  // « Chapitre 7 », « Section 5 »). Les vrais chapitres nommés (« Serment »,
  // « Première partie. Patagonie », « Note de l'auteur ») n'en sont pas.
  function estMicroChap(t) {
    t = (t || "").trim();
    return estNumeroChap(t) || /^section\s+\d+$/i.test(t);
  }
  function premierNombre(t) { const m = String(t || "").match(/\d+/); return m ? m[0] : null; }
  // Regroupe UNIQUEMENT les suites de micro-chapitres en paquets de 10
  // (« Chapitres 2 – 11 »…), en laissant intacts les vrais chapitres, où qu'ils
  // soient (début, milieu ou fin du livre). Actif seulement si le livre est très
  // découpé (> SEUIL_GROUPE entrées au total).
  const SEUIL_GROUPE = 30;
  function grouperMicro(liste) {
    if (!liste || liste.length <= SEUIL_GROUPE) return liste;
    const out = [];
    let run = [];
    const vider = () => {
      while (run.length) {
        const pack = run.splice(0, 10);
        if (pack.length === 1) { out.push(pack[0]); continue; }
        const a = premierNombre(pack[0].titre), b = premierNombre(pack[pack.length - 1].titre);
        const lbl = (a && b) ? ("Chapitres " + a + " – " + b)
                             : ((pack[0].titre || "—") + " – " + (pack[pack.length - 1].titre || "—"));
        out.push({ titre: lbl, debut: pack[0].debut });
      }
    };
    for (const c of liste) {
      if (estMicroChap(c.titre)) run.push(c);
      else { vider(); out.push(c); }
    }
    vider();
    return out;
  }
  // Construit la liste affichée selon le mode :
  //  - "existante" : TOC d'origine nettoyée (couvertures coupées, numéros corrigés).
  //  - "optimisee" : vrais chapitres conservés, suites de micro-chapitres regroupées
  //                  en paquets de 10 (pour les livres au découpage excessif).
  function construireTOC(brut, mode) {
    if (!brut || !brut.length) return brut || [];
    let chaps = nettoyer(brut).filter((c) => categorie(c.titre) !== "couv");
    if (!chaps.length) chaps = [{ titre: "Début", debut: 0 }];
    if (mode !== "optimisee") return chaps;
    return grouperMicro(chaps);
  }


// Extrait le livre sous forme de TEXTE BRUT par chapitre : [{ titre, texte }].
// La tokenisation en mots (et donc les index de chapitre) est faite ENSUITE
// par le modèle actif (tokeniserChapitres), pour que chaque modèle puisse
// découper le texte à sa façon. Les chapitres viennent de la TOC (ancres
// incluses) ; sinon une entrée par section.
// Pages de garde / annexes à exclure du menu des chapitres (couverture,
// copyright, table des matières, « du même auteur »…). Comparé au titre nettoyé.
const RE_PAGE_GARDE = /^\s*(couverture|cover|page de titre|faux[- ]?titre|titre|copyright|page\s+l[ée]gale|mentions?\s+l[ée]gales?|achev[ée]\s+d[' ]?imprim\w*|d[ée]p[ôo]t\s+l[ée]gal|colophon|ours|du\s+m[êe]me\s+auteure?|de\s+la\s+m[êe]me\s+auteure?|dans\s+la\s+m[êe]me\s+(s[ée]rie|collection)|table\s+des\s+mati[èe]res|table|sommaire|index|remerciements?|cr[ée]dits?|[àa]\s+propos\s+de\s+l['' ]auteure?|biographie|pr[ée]sentation|exergue|[ée]pigraphe|d[ée]dicace|sch[ée]mas?|illustrations?|page\s+titre|page\s+de\s+garde|quatri[èe]me\s+de\s+couverture|title\s+page|half[- ]?title|table\s+of\s+contents|contents|acknowledge?ments?|about\s+the\s+author|also\s+by|by\s+the\s+same\s+author|dedication|imprint|frontispiece|back\s+cover|notes?)\s*[.:]?\s*$/i;
function estPageGarde(titre) { return RE_PAGE_GARDE.test((titre || "").replace(/\s+/g, " ").trim()); }
// Normalise un titre pour comparaison (sans casse/accents/espaces multiples).
function normTitre(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Un titre qui n'est qu'un NUMÉRO de chapitre (chiffre, romain, ordinal écrit) —
// sert à fusionner « I » + « Une petite ville » → « I · Une petite ville ».
function estNumeroChap(t) {
  t = (t || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return false;
  if (/^(chap(itre)?|chapter)?\.?\s*(\d{1,3}|[IVXLCDM]{1,8})\.?$/i.test(t)) return true;
  return /^(chap(itre)?|chapter)?\.?\s*(premier|premi[èe]re|deuxi[èe]me|second[e]?|troisi[èe]me|quatri[èe]me|cinqui[èe]me|sixi[èe]me|septi[èe]me|huiti[èe]me|neuvi[èe]me|dixi[èe]me|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten)$/i.test(t);
}

// Titre d'une section déduit de ses balises : 1er titre (h1–h6, sinon classes
// chap/titre/title), en fusionnant un numéro suivi de son intitulé.
function titreDepuisSection(corps) {
  if (!corps || !corps.querySelectorAll) return "";
  const net = (s) => (s || "").replace(/\s+/g, " ").trim();
  let els = [];
  try { els = [...corps.querySelectorAll("h1,h2,h3,h4,h5,h6")]; } catch (e) {}
  if (!els.length) {
    try { els = [...corps.querySelectorAll("[class*='chap_title'],[class*='chapitre'],[class*='titre'],[class*='title']")]; } catch (e) {}
  }
  const cand = [];
  for (const el of els) {
    const t = net(el.textContent);
    if (t && t.length <= 90) cand.push(t);
    if (cand.length >= 2) break;
  }
  if (!cand.length) return "";
  if (cand.length >= 2 && estNumeroChap(cand[0]) && !estNumeroChap(cand[1]))
    return cand[0] + " · " + cand[1];
  return cand[0];
}

// Motifs de titre candidats. Chaque motif teste une LIGNE (déjà compactée) et
// dit si elle a la forme d'un en-tête de division. On les confirme ensuite sur
// l'ensemble du livre (récurrence régulière) avant de s'en servir.
// Numéros écrits : chiffres, romains, ordinaux FR et EN (« deuxième », « second »).
const NUM_MOT = "(\\d{1,3}|[IVXLCDM]{1,8}" +
  "|premi[eè]re?|deuxi[eè]me|troisi[eè]me|quatri[eè]me|cinqui[eè]me|sixi[eè]me|septi[eè]me|huiti[eè]me|neuvi[eè]me|dixi[eè]me|onzi[eè]me|douzi[eè]me|treizi[eè]me|quatorzi[eè]me|quinzi[eè]me|second[e]?" +
  "|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|one|two|three|four|five|six|seven|eight|nine|ten)";
// En-tête de division : « (Première) Partie/Livre/Tome » FR, « Part/Book » EN.
const DIV_HAUT = "(partie|livre|tome|part|book)";
// Chapitre : « Chapitre N » FR, « Chapter N » EN.
const DIV_CHAP = "(chap(itre)?|chapter)";
const MOTIFS_TITRE = [
  { id: "partie",   niveau: 0, re: new RegExp("^(" + NUM_MOT + "\\s+)?" + DIV_HAUT + "\\b", "i") },
  { id: "partie2",  niveau: 0, re: new RegExp("^" + DIV_HAUT + "\\s+" + NUM_MOT + "\\b", "i") },
  { id: "section",  niveau: 0, re: new RegExp("^(prologue|epilogue|[ée]pilogue|pr[ée]face|avant[- ]?propos|introduction|conclusion|foreword|preface|prologue)\\b", "i") },
  { id: "chapitre", niveau: 1, re: new RegExp("^" + DIV_CHAP + "\\.?\\s*" + NUM_MOT + "\\b", "i") },
  // Numéro SUIVI d'un séparateur net (point, tiret, parenthèse) puis éventuel
  // intitulé : « 12. », « IV. Le titre », « 3 - … », « 3 — … », « 3) … ». Le
  // séparateur lève l'ambiguïté avec un nombre de contexte ou le « I » anglais.
  { id: "numsep",   niveau: 1, re: new RegExp(String.raw`^(\d{1,3}|[IVXLCDM]{1,8})\s*([.)\-\u2013\u2014]\s*\S?|\s{2,}\S)`) },
  // Nombre seul sur sa ligne (« 12 », « IV ») — accepté mais plus faible.
  { id: "numseul",  niveau: 1, re: /^(\d{1,3}|[IVXLCDM]{1,8})$/ },
  // « maj » (ligne tout en majuscules) n'est PAS un motif de chapitre autonome
  // (trop bruité : « FIN », noms d'éditeur…). Il sert seulement d'INTITULÉ fusionné
  // après un en-tête numéroté (« PREMIÈRE PARTIE » + « LA PEUR »).
];
function compacter(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function estLigneMaj(t) {
  const lettres = t.replace(/[^\p{L}]/gu, "");
  return lettres.length >= 2 && lettres === lettres.toUpperCase() &&
         lettres.toUpperCase() !== lettres.toLowerCase();
}
// Quel(s) motif(s) une ligne valide-t-elle ? (ligne courte, pas une phrase)
// Si un motif de NIVEAU 0 (partie/livre) matche, on n'ajoute pas « maj » : une
// ligne « PREMIÈRE PARTIE » est une partie, pas un simple intitulé majuscule.
function motifsDeLigne(ligne) {
  const t = compacter(ligne);
  if (!t || t.length > 60) return [];
  if (/[.!?…,;:]$/.test(t) && !/^(\d{1,3}|[IVXLCDM]{1,8})\s*\.$/.test(t)) return [];
  const ids = [];
  for (const m of MOTIFS_TITRE) {
    if (m.re && m.re.test(t)) ids.push(m);
  }
  return ids;
}

// Redécoupe les livres FAIBLEMENT chapitrés (« Section N ») d'après les titres
// « visuels » du texte, en deux temps : (1) APPRENTISSAGE — on relève tous les
// motifs candidats et leurs occurrences ; (2) CONFIRMATION — on ne retient que les
// motifs RÉCURRENTS (strict ≥5, repli souple ≥3 pour les livres courts), puis on
// garde au plus 2 niveaux (parties + chapitres). Évite les faux positifs (une
// ligne en capitales isolée n'est pas retenue si le motif ne se répète pas).
function redecouperParTitresVisuels(chapitres) {
  const estFaible = (c) => /^section\s+\d+$/i.test((c.titre || "").trim());
  if (chapitres.filter(estFaible).length < chapitres.length * 0.5) return chapitres;

  // Aplatissement en lignes (en gardant la frontière des chapitres faibles, qui
  // ne doivent PAS couper le flux : ce sont des fichiers Calibre intermédiaires).
  const SEP = String.fromCharCode(0);   // sentinel de frontière de section
  const lignes = [];
  chapitres.forEach((c) => {
    String(c.texte || "").split(/\n/).forEach((b) => lignes.push(b));
    lignes.push(SEP);   // séparateur de section (neutralisé ensuite)
  });

  // (1) Apprentissage : occurrences de chaque motif (lignes « isolées » = précédées d'un blanc).
  const occ = {};   // motifId -> [indices de ligne]
  for (let i = 0; i < lignes.length; i++) {
    const raw = lignes[i]; if (raw === SEP || !raw.trim()) continue;
    const prec = i > 0 ? lignes[i - 1] : "";
    const isole = i === 0 || prec === SEP || prec.trim() === "";
    if (!isole) continue;
    for (const m of motifsDeLigne(raw)) (occ[m.id] = occ[m.id] || []).push(i);
  }

  // (2) Confirmation : un motif est valide s'il récurre. Niveau 1 (chapitres) :
  // strict ≥5 (repli ≥3 sur livres courts). Niveau 0 (parties) : par nature rare,
  // on accepte dès ≥2 occurrences.
  const total = chapitres.length;
  const SEUIL1 = total <= 6 ? 3 : 5;            // chapitres
  const SEUIL0 = 2;                             // parties
  const niveauDe = {}; MOTIFS_TITRE.forEach((m) => { niveauDe[m.id] = m.niveau; });
  const seuilDe = (id) => (niveauDe[id] === 0 ? SEUIL0 : SEUIL1);
  const valides = Object.keys(occ).filter((id) => occ[id].length >= seuilDe(id));
  if (!valides.length) return chapitres;        // aucune structure fiable → on ne touche pas

  // Garde au plus 2 niveaux : 1 motif de niveau 0 (parties, le plus rare) + 1 de
  // niveau 1 (chapitres, le plus fréquent).
  const parNiveau = (n) => valides.filter((id) => niveauDe[id] === n)
    .sort((a, b) => occ[b].length - occ[a].length);
  const motNiv0 = parNiveau(0)[0];              // parties : on prend le plus présent
  const motNiv1 = parNiveau(1)[0];              // chapitres : idem
  const retenus = new Set([motNiv0, motNiv1].filter(Boolean));
  const estTitre = new Set();
  retenus.forEach((id) => occ[id].forEach((i) => estTitre.add(i)));
  if (!estTitre.size) return chapitres;

  // Découpe finale, en fusionnant un en-tête (« PREMIÈRE PARTIE ») avec l'intitulé
  // en MAJUSCULES qui suit (« LA PEUR ») → « PREMIÈRE PARTIE · LA PEUR ».
  const out = [];
  let courant = { titre: chapitres[0] ? chapitres[0].titre : "Début", texte: [] };
  const pousser = () => {
    const txt = courant.texte.join("\n").replace(/\n{2,}/g, "\n\n").trim();
    if (txt || out.length === 0) out.push({ titre: courant.titre, texte: txt });
  };
  for (let i = 0; i < lignes.length; i++) {
    const raw = lignes[i]; if (raw === SEP) continue;
    if (estTitre.has(i)) {
      let titre = compacter(raw);
      // Fusion « 2 lignes » : un en-tête qui n'est qu'un NUMÉRO/division (« IV »,
      // « Chapitre 3 », « PREMIÈRE PARTIE ») suivi d'une 2e ligne courte ISOLÉE qui
      // est l'intitulé (« Les 3 petits chats », « LA PEUR ») → « IV · Les 3 … ».
      // L'intitulé peut être en minuscules : on exige juste une ligne courte, non
      // marquée titre, et qui n'est pas une phrase (pas de ponctuation finale).
      const enteteNum = /(partie|livre|tome|part|book)\b/i.test(titre) ||
        new RegExp("^(" + DIV_CHAP + "\\.?\\s*)?" + NUM_MOT + "[.)\\-\\u2013\\u2014]?$", "i").test(titre);
      let j = i + 1; while (j < lignes.length && (lignes[j] === SEP || lignes[j].trim() === "")) j++;
      const suite = j < lignes.length ? compacter(lignes[j]) : "";
      const intituleOk = suite && suite.length <= 60 && !estTitre.has(j) &&
        !/[.!?…]$/.test(suite) && /\p{L}/u.test(suite);
      if (enteteNum && intituleOk) {
        titre += " · " + suite;
        for (let k = i + 1; k <= j; k++) lignes[k] = SEP;
      }
      pousser();
      courant = { titre: titre, texte: [] };
    } else {
      courant.texte.push(raw);
    }
  }
  pousser();
  // Garde-fou : la reconstruction doit AJOUTER des divisions, jamais détruire un
  // chapitrage existant. Si elle effondre beaucoup de sections en très peu (ex.
  // un ePUB dont le ncx pointe vers des fichiers absents, et dont le texte n'a
  // aucun « Chapitre N » → tout fusionné en 2), on garde les sections d'origine.
  if (out.length < 5 && chapitres.length >= 10 && out.length < chapitres.length) return chapitres;
  return out;
}

async function extraireLivre(livre) {
  const toc = [];
  try {
    const nav = await livre.loaded.navigation;
    const parcourir = (liste) => liste.forEach((item) => {
      if (item.href) toc.push({ href: item.href, label: (item.label || "").trim() });
      if (item.subitems && item.subitems.length) parcourir(item.subitems);
    });
    if (nav && nav.toc) parcourir(nav.toc);
  } catch (e) { /* pas de TOC */ }

  // TOC « fiable » ? Au moins 3 entrées avec un vrai libellé (hors « Démarrer »,
  // couverture, sommaire…). Sinon on reconstruira le chapitrage via les balises
  // (1 fichier du spine = 1 chapitre, titre tiré des <h>/classes).
  const RE_TOC_BIDON = /^(d[ée]marrer|start|begin|texte|content|cover)$/i;
  const labelsUtiles = toc.filter((t) => {
    const l = (t.label || "").trim();
    return l && !RE_TOC_BIDON.test(l) && !estPageGarde(l);
  });
  const tocFiable = labelsUtiles.length >= 3;

  // Titre du livre (pour reconnaître les pages de titre répétées).
  let titreLivre = "";
  try {
    const meta = (await livre.loaded.metadata) || {};
    titreLivre = normTitre(typeof meta.title === "string" ? meta.title : (meta.title && (meta.title.name || meta.title.value)) || "");
  } catch (e) {}
  // Une section est-elle une « garde » (à fusionner, pas un vrai chapitre) ?
  // Pages connues, page de titre (= titre du livre), ou titre généré « Section N »
  // pour une section courte (couverture, page sans contenu).
  function estGarde(titre, texte) {
    if (estPageGarde(titre)) return true;
    const tt = (titre || "").replace(/\s+/g, " ").trim();
    // Colophon / mentions d'imprimeur en fin de livre (ex. « PARIS – 22, RUE… »,
    // « (G. O. : 31.2348) », « TABLE DES-MATIÈRES »).
    if (/^table\s+des[-\s]+mati[èe]res/i.test(tt)) return true;
    if (/^\(?\s*g\.?\s*o\.?\s*[:.]/i.test(tt)) return true;
    if (/\b(rue|imprim|achev|d[ée]p[ôo]t\s+l[ée]gal)\b/i.test(tt) && tt.length < 60) return true;
    // Ligne de table des matières résiduelle : « … Partie … <numéro de page> ».
    if (/\bpartie\b/i.test(tt) && /\s\d{1,4}\s*$/.test(tt)) return true;
    // Page de titre = titre du livre (comparaison sans espaces, car un <br> dans
    // le titre peut coller les mots : « Le cercledes sept pierres »).
    const compact = (s) => normTitre(s).replace(/\s+/g, "");
    if (titreLivre && compact(titre) === compact(titreLivre)) return true;
    // Section au titre générique (« Section N ») et au contenu court = garde
    // (couverture, page de titre, schémas, etc. sans vrai chapitrage).
    if (/^section\s+\d+$/i.test((titre || "").trim()) && (texte || "").length < 600) return true;
    return false;
  }

  // Texte brut entre deux éléments (ou début/fin de section)
  const texteEntre = (doc, corps, debutEl, finEl) => {
    try {
      const range = doc.createRange();
      if (debutEl) range.setStartBefore(debutEl); else range.setStart(corps, 0);
      if (finEl) range.setEndBefore(finEl); else range.setEndAfter(corps);
      const div = doc.createElement("div");
      div.appendChild(range.cloneContents());
      return texteAvecSeparateurs(div).trim();
    } catch (e) { return ""; }
  };

  const chapitresTexte = [];   // [{ titre, texte }]
  const notesArr = [];         // contenus des annotations, indexés par noteId
  const idMap = {};            // id d'ancre -> texte (pour les notes d'une autre section)
  const attente = [];          // renvois à résoudre après le parcours complet
  let nSection = 0;

  for (const section of livre.spine.spineItems) {
    try {
      const contenu = await section.load(livre.load.bind(livre));
      let corps = null, doc = null;
      if (contenu) {
        if (contenu.body) { corps = contenu.body; doc = contenu; }
        else if (contenu.querySelector) {
          corps = contenu.querySelector("body") || contenu;
          doc = contenu.ownerDocument || contenu;
        }
      }
      if (corps && doc) { try { baliserNotes(doc, corps, notesArr, idMap, attente); } catch (e) {} }
      const fullText = corps ? texteAvecSeparateurs(corps).trim()
                             : (contenu ? (contenu.textContent || "").trim() : "");
      if (!fullText) continue;
      const baseHref = (section.href || "").split("#")[0];
      nSection++;

      // Entrées TOC de cette section (ignorées si la TOC n'est pas fiable)
      const entriesIci = tocFiable ? toc.filter((t) => t.href.split("#")[0] === baseHref) : [];
      const sansAncre = entriesIci.find((t) => !t.href.includes("#"));
      // Titre de la section : libellé TOC si fiable, sinon déduit des balises,
      // sinon « Section N ». (1 fichier du spine = 1 chapitre quand pas de TOC.)
      const labelSection = (sansAncre && sansAncre.label) ||
        (entriesIci[0] && !entriesIci[0].href.includes("#") ? entriesIci[0].label : "") ||
        titreDepuisSection(corps) ||
        ("Section " + nSection);

      // Ancres présentes, dans l'ordre du document
      const ancres = [];
      if (corps && doc && doc.createRange) {
        entriesIci.forEach((t) => {
          const id = t.href.split("#")[1];
          if (!id) return;
          let el = null;
          try { el = corps.querySelector("#" + cssEchappe(id)); } catch (e) {}
          if (!el && doc.getElementById) el = doc.getElementById(id);
          if (el) ancres.push({ label: t.label, el });
        });
        ancres.sort((a, b) =>
          (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
      }

      if (ancres.length === 0) {
        chapitresTexte.push({ titre: labelSection, texte: fullText, garde: estGarde(labelSection, fullText) });
      } else {
        // Texte avant la 1re ancre -> rattaché au chapitre précédent, ou "Début"
        const avant = texteEntre(doc, corps, null, ancres[0].el);
        if (avant) {
          if (chapitresTexte.length) chapitresTexte[chapitresTexte.length - 1].texte += "\n" + avant;
          else chapitresTexte.push({ titre: labelSection || "Début", texte: avant, garde: estGarde(labelSection, avant) });
        }
        ancres.forEach((a, i) => {
          const t = texteEntre(doc, corps, a.el, ancres[i + 1] ? ancres[i + 1].el : null);
          if (t) chapitresTexte.push({ titre: a.label || ("Chapitre " + chapitresTexte.length), texte: t, garde: estGarde(a.label, t) });
        });
      }
    } catch (e) {
      console.warn("Section illisible ignorée", e);
    } finally {
      section.unload();
    }
  }

  if (chapitresTexte.length === 0) chapitresTexte.push({ titre: "Début", texte: "" });

  // Numéros de page « parasites » (folios de l'édition papier aplatis en texte)
  retirerFolios(chapitresTexte);

  // Livres faiblement chapitrés (« Section N » faute de TOC/balises) : on tente
  // un redécoupage d'après les titres « visuels » présents dans le texte
  // (PARTIE / CHAPITRE / chiffres romains / lignes en MAJUSCULES).
  const reparti = redecouperParTitresVisuels(chapitresTexte);
  // Ré-évalue le drapeau « garde » sur les chapitres (re)produits (le redécoupage
  // peut faire apparaître une table/colophon de fin comme chapitre).
  reparti.forEach((c) => { c.garde = estGarde(c.titre, c.texte); });

  // Pages de garde (couverture, copyright, dédicace, table…) : on ne les montre
  // PAS comme chapitres, mais on garde leur texte en le fusionnant dans le
  // chapitre de contenu voisin (les pages de tête → 1er vrai chapitre ; celles
  // de fin → dernier). Le menu des chapitres ne liste alors que le contenu réel.
  let fusionne = fusionnerPagesGarde(reparti);
  // Nettoyage du drapeau interne avant stockage
  fusionne.forEach((c) => { delete c.garde; });
  // Recadrage des chapitres au sommaire intégré (page de titre collée au texte).
  fusionne = recadrerSurSommaire(fusionne);

  // Résolution des notes pointant vers une autre section (endnotes regroupées).
  attente.forEach((p) => {
    if (!notesArr[p.noteId].texte && idMap[p.fragId]) notesArr[p.noteId].texte = nettoyerNote(idMap[p.fragId]);
  });
  return { chapitresTexte: fusionne, notes: notesArr };
}

// Retire les NUMÉROS DE PAGE (folios de l'édition papier) aplatis dans le texte.
// Deux formes : un bloc ne contenant qu'un nombre (« 30 ») ; un nombre détaché en
// fin/début de bloc au fil du texte (« …nécessité 39 » puis suite). On n'agit QUE
// si l'ensemble des nombres isolés forme une suite LARGEMENT CROISSANTE (signature
// d'une pagination) — sinon on ne touche à rien (zéro risque sur les vrais nombres
// et sur les appels de note, déjà traités en amont).
function retirerFolios(chapitres) {
  // 1) Recense tous les « nombres isolés » (un bloc = juste un entier 1–4 chiffres)
  //    dans l'ordre du livre, pour tester la monotonie croissante.
  const isoles = [];
  const reBlocNum = /^\s*\d{1,4}\s*$/;
  chapitres.forEach((c) => {
    String(c.texte || "").split(/\n+/).forEach((b) => {
      if (reBlocNum.test(b)) isoles.push(parseInt(b, 10));
    });
  });
  if (isoles.length < 8) return;                 // trop peu pour conclure : on s'abstient
  let croissants = 0;
  for (let i = 1; i < isoles.length; i++) if (isoles[i] >= isoles[i - 1]) croissants++;
  if (croissants / (isoles.length - 1) < 0.8) return;   // pas une pagination → on ne touche à rien

  // 2) Filtrage bloc par bloc.
  const reFinNum = /\s+(\d{1,4})\s*$/;            // « …phrase 39 »
  const reDebutNum = /^\s*(\d{1,4})\s+/;          // « 39 phrase… »
  chapitres.forEach((c) => {
    const blocs = String(c.texte || "").split(/\n/);
    const out = [];
    for (let i = 0; i < blocs.length; i++) {
      let b = blocs[i];
      if (reBlocNum.test(b)) continue;            // bloc = un folio seul → supprimé
      // Folio collé en fin de bloc, suivi (après blocs vides) d'un bloc qui
      // CONTINUE la phrase (commence par une minuscule) → on retire le nombre et
      // on RECOLLE les deux morceaux. Garde-fou : le bloc courant ne finit pas par
      // une ponctuation forte (sinon le nombre pourrait être légitime).
      const mFin = b.match(reFinNum);
      if (mFin && !/[.!?…:]$/.test(b.replace(reFinNum, "").trimEnd())) {
        let j = i + 1;
        while (j < blocs.length && blocs[j].trim() === "") j++;
        const suite = blocs[j];
        if (suite && /^\s*[a-zàâäéèêëîïôöùûüç]/.test(suite)) {
          b = b.replace(reFinNum, "");            // enlève le folio
          out.push(b.trimEnd() + " " + suite.trimStart());  // recolle la phrase
          blocs[j] = "";                          // la suite est consommée
          continue;
        }
      }
      out.push(b);
    }
    c.texte = out.join("\n").replace(/\n{2,}/g, "\n\n").trim();
  });
}

// Fusionne les pages de garde/annexes (drapeau `garde`) dans le chapitre de
// contenu voisin pour qu'elles ne polluent pas le menu des chapitres, sans
// perdre leur texte. S'il n'y a aucun « vrai » chapitre, on ne touche à rien.
function fusionnerPagesGarde(chs) {
  const reels = chs.filter((c) => !c.garde);
  if (!reels.length || reels.length === chs.length) return chs;
  const out = [];
  for (const c of chs) {
    if (c.garde) {
      const cible = out.length ? out[out.length - 1]   // rattache au précédent (réel)
                               : null;
      if (cible && !cible.garde) { cible.texte += "\n" + c.texte; continue; }
      // garde de tête (aucun réel avant) : on la met en attente sur le prochain réel
      out.push(c);
    } else {
      // absorbe d'éventuelles gardes de tête accumulées juste avant
      while (out.length && out[out.length - 1].garde) {
        const g = out.pop();
        c.texte = g.texte + "\n" + c.texte;
      }
      out.push(c);
    }
  }
  // S'il reste des gardes (livre tout en garde au début) : on les garde telles quelles
  return out;
}

// Recadrage « sommaire intégré » (option A) : certains EPUB mettent dans le même
// fichier la page de titre + un SOMMAIRE qui re-liste tous les titres + le vrai
// texte, sans repère d'ancre. L'entrée démarre alors tout en haut (sur la page de
// titre). Quand le titre d'un chapitre RÉAPPARAÎT plus bas comme un bloc isolé,
// suivi de vraie prose (et précédé d'un SOMMAIRE ou de plusieurs autres titres),
// on coupe : la tête (pages liminaires) devient un bloc masqué — gardé dans le
// flux mais absent du menu — et le chapitre démarre à sa vraie position.
function recadrerSurSommaire(chs) {
  const titresN = new Set(chs.map((c) => normTitre(c.titre)).filter(Boolean));
  const out = [];
  for (const c of chs) {
    const titreN = normTitre(c.titre);
    const blocs = String(c.texte || "").split(/\n+/);
    let pos = -1;
    if (titreN) {
      for (let b = 1; b < blocs.length; b++) {
        if (normTitre(blocs[b]) !== titreN) continue;
        // bloc de contenu qui suit (on saute les vides) : doit être de la prose,
        // pas un autre titre du livre.
        let n = b + 1;
        while (n < blocs.length && !blocs[n].trim()) n++;
        const suite = blocs[n] || "";
        if (suite.length >= 50 && !titresN.has(normTitre(suite))) { pos = b; break; }
      }
    }
    if (pos < 1) { out.push(c); continue; }
    const tete = blocs.slice(0, pos);
    // La tête doit clairement être des pages liminaires : un « SOMMAIRE » /
    // « table des matières », ou au moins deux autres titres du livre listés.
    const aSommaire = tete.some((b) => /^(sommaire|table\s+des[\s-]+mati)/.test(normTitre(b)));
    const autres = tete.filter((b) => { const n = normTitre(b); return n && n !== titreN && titresN.has(n); }).length;
    if (!aSommaire && autres < 2) { out.push(c); continue; }
    out.push({ titre: "Pages liminaires", texte: tete.join("\n\n"), masque: true });
    out.push({ titre: c.titre, texte: blocs.slice(pos).join("\n\n") });
  }
  return out;
}

// Tokenise le texte par chapitre avec le découpage `decouper` du modèle actif,
// et calcule les index de début de chaque chapitre.
// Sentinelle de renvoi de note insérée dans le texte à l'extraction :
// <noteId> (caractères de zone privée, invisibles, sans espace →
// la marque reste collée au mot qui précède). On la retire des mots affichés
// et on mémorise, pour chaque mot, les notes qui s'y rattachent.
const RE_NOTE = /(\d+)/g;
const NOTE_DEB = String.fromCharCode(0xE000), NOTE_FIN = String.fromCharCode(0xE001);
function marqueNote(id) { return NOTE_DEB + id + NOTE_FIN; }
function tokeniserChapitres(chapitresTexte, decouper) {
  const mots = [];
  const chapitres = [];
  const debuts = new Set();   // index des mots qui commencent un bloc/paragraphe
  const refs = [];            // { motIndex, noteId } : renvois de note par mot
  (chapitresTexte || []).forEach((ch) => {
    // Chaque bloc (séparé par un saut de ligne) est traité comme un paragraphe :
    // son 1er mot devient un « début de phrase » (respiration + pas de fusion
    // d'un titre avec le paragraphe suivant).
    const paras = String(ch.texte || "").split(/\n+/);
    let chapAjoute = false;
    paras.forEach((para) => {
      const m = decouper(para);
      if (m.length === 0) return;
      // Nettoie les sentinelles de note de chaque jeton et note leur position.
      const propres = [];
      for (let t of m) {
        const trouves = [];
        t = t.replace(RE_NOTE, (x, id) => { trouves.push(+id); return ""; });
        if (t === "") {                       // marque seule → mot précédent
          const cible = mots.length + propres.length - 1;
          trouves.forEach((id) => refs.push({ motIndex: Math.max(0, cible), noteId: id }));
          continue;
        }
        const idx = mots.length + propres.length;
        trouves.forEach((id) => refs.push({ motIndex: idx, noteId: id }));
        propres.push(t);
      }
      if (propres.length === 0) return;
      // Un bloc « masqué » (pages liminaires recadrées) garde ses mots dans le
      // flux mais ne crée PAS d'entrée de chapitre dans le menu.
      if (!chapAjoute && !ch.masque) {
        chapitres.push({ titre: ch.titre || "Chapitre", debut: mots.length });
        chapAjoute = true;
      }
      debuts.add(mots.length);
      for (const w of propres) mots.push(w);
    });
  });
  if (chapitres.length === 0) chapitres.push({ titre: "Début", debut: 0 });
  corrigerNomsColles(mots);
  return { mots, chapitres, debuts, refs };
}

// Corrige les noms propres COLLÉS par erreur dans l'EPUB (« SaintGermain ») quand
// la forme correcte avec trait d'union (« Saint-Germain ») est attestée AILLEURS
// dans le même livre. 100 % data-driven : on ne corrige que si la bonne forme existe,
// donc « MacKenzie », « DuBois »… (jamais écrits « Mac-Kenzie ») ne sont pas touchés.
function corrigerNomsColles(mots) {
  const RE_PAIRE = /^(\p{Lu}[\p{Ll}]+)-(\p{Lu}[\p{L}]+)$/u;   // « Saint-Germain »
  const RE_COLLE = /^(\p{Lu}[\p{Ll}]+)(\p{Lu}[\p{L}]+)$/u;     // « SaintGermain »
  const noyau = (w) => {
    const pre = (w.match(/^[^\p{L}]*/u) || [""])[0];
    const suf = (w.match(/[^\p{L}]*$/u) || [""])[0];
    return [pre, w.slice(pre.length, w.length - suf.length), suf];
  };
  const carte = Object.create(null);
  for (const w of mots) {
    const m = noyau(w)[1].match(RE_PAIRE);
    if (m) { const k = (m[1] + m[2]).toLowerCase(); if (!carte[k]) carte[k] = m[1] + "-" + m[2]; }
  }
  if (!Object.keys(carte).length) return;
  for (let i = 0; i < mots.length; i++) {
    const [pre, core, suf] = noyau(mots[i]);
    const m = core.match(RE_COLLE);
    if (!m) continue;
    const corr = carte[(m[1] + m[2]).toLowerCase()];
    if (corr && corr !== core) mots[i] = pre + corr + suf;
  }
}

// Échappe un id pour querySelector (CSS.escape si dispo)
function cssEchappe(id) {
  if (window.CSS && CSS.escape) return CSS.escape(id);
  return id.replace(/([^\w-])/g, "\\$1");
}

// Extrait le texte d'un élément en insérant des espaces entre les blocs,
// sinon "titre" et "paragraphe" se collent ("premierLa").
// Carte des classes/balises qui changent la CASSE des lettres affichées
// (text-transform / font-variant: small-caps), lue dans le CSS de l'EPUB.
let carteCasse = null;
function construireCarteCasse(cssText) {
  const carte = { upper: new Set(), lower: new Set(), cap: new Set() };
  if (!cssText) return carte;
  cssText = cssText.replace(/\/\*[\s\S]*?\*\//g, "");      // enlève les commentaires
  const re = /([^{}]+)\{([^}]*)\}/g; let m;
  while ((m = re.exec(cssText))) {
    const corps = m[2];
    let mode = null;
    const tt = /text-transform\s*:\s*(uppercase|lowercase|capitalize)/i.exec(corps);
    if (tt) mode = tt[1].toLowerCase() === "uppercase" ? "upper"
                 : tt[1].toLowerCase() === "lowercase" ? "lower" : "cap";
    if (/font-variant(-caps)?\s*:\s*[^;]*(small-caps|petite-caps)/i.test(corps)) mode = "upper";
    if (!mode) continue;
    m[1].split(",").forEach((s) => {
      s = s.trim();
      const cls = s.match(/\.[-\w]+/g);          // sélecteurs de classe
      if (cls) cls.forEach((c) => carte[mode].add(c));
      else if (/^[a-zA-Z][\w-]*$/.test(s)) carte[mode].add(s.toLowerCase()); // sélecteur de balise
    });
  }
  return carte;
}
// Applique les transformations de casse sur les éléments correspondants.
function appliquerCasse(racine) {
  const c = carteCasse;
  if (!c) return;
  [["cap", c.cap], ["lower", c.lower], ["upper", c.upper]].forEach(([mode, set]) => {
    if (!set.size) return;
    let els;
    try { els = racine.querySelectorAll([...set].join(",")); } catch (e) { return; }
    els.forEach((el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (mode === "upper") n.nodeValue = n.nodeValue.toUpperCase();
        else if (mode === "lower") n.nodeValue = n.nodeValue.toLowerCase();
        else n.nodeValue = n.nodeValue.replace(/(^|\s)(\p{L})/gu, (x, a, b) => a + b.toUpperCase());
      }
    });
  });
}

// Retire les APPELS de note (exposants « 13 », liens « noteref »…) qui, aplatis
// en texte simple, viennent polluer la lecture rapide (ex. « 1789 » + « 13 » →
// « 178913 »). On s'appuie sur le balisage pour ne pas toucher aux exposants
// légitimes (ordinaux « 1ᵉʳ », « XVIᵉ »… qui contiennent des lettres).
function retirerAppelsNote(racine) {
  if (!racine || !racine.querySelectorAll) return;
  const estNumero = (t) => {
    const n = (t || "").trim().replace(/[\[\]()]/g, "");
    return /^\d{1,4}$/.test(n) || /^[*†‡§¶+]+$/.test(n);
  };
  // 1) Éléments explicitement marqués comme appels de note (EPUB3 / ARIA).
  racine.querySelectorAll("*").forEach((el) => {
    let t = (el.getAttribute("epub:type") || "");
    try { t += " " + (el.getAttributeNS("http://www.idpf.org/2007/ops", "type") || ""); } catch (e) {}
    t = (t + " " + (el.getAttribute("role") || "")).toLowerCase();
    if (/noteref/.test(t)) el.remove();
  });
  // 2) Liens vers une ancre dont le texte n'est qu'un nombre/symbole court.
  racine.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href.includes("#") && estNumero(a.textContent)) (a.closest("sup") || a).remove();
  });
  // 3) Exposants composés uniquement d'un nombre/symbole (numéro de note sans lien).
  racine.querySelectorAll("sup").forEach((s) => {
    const t = (s.textContent || "").trim();
    if (t === "" || estNumero(t)) s.remove();
  });
  // 4) Conteneurs de NOTE marqués (leur contenu est montré dans la bulle) :
  //    on les sort du flux de lecture pour ne pas les lire deux fois.
  racine.querySelectorAll("*").forEach((el) => {
    let t = (el.getAttribute("epub:type") || "");
    try { t += " " + (el.getAttributeNS("http://www.idpf.org/2007/ops", "type") || ""); } catch (e) {}
    t = (t + " " + (el.getAttribute("role") || "")).toLowerCase();
    if (/footnote|endnote|rearnote|doc-footnote|doc-endnote|(^|\s)note(\s|$)/.test(t)) el.remove();
  });
}

// Nettoie le texte d'une annotation : enlève un numéro/puce en tête (souvent
// répété) et les flèches « retour » des liens de renvoi.
function nettoyerNote(t) {
  t = (t || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[\[(]?\s*\d{1,4}\s*[\]).°:]?\s*/, "");
  t = t.replace(/[↑↩⤴⮮⇧⬆]/g, "").trim();
  return t;
}

// Repère les RENVOIS de note dans une section (exposants/liens « noteref ») et
// les remplace, dans le document d'origine, par une sentinelle invisible
// <id> collée au mot. Mémorise le contenu de la note (résolu dans la
// même section si possible, sinon en attente via la table d'identifiants idMap,
// renseignée pour toutes les sections puis résolue à la fin).
// Texte d'une cible de note : si l'ancre pointe sur le LIEN de retour (« 1 »)
// à l'intérieur du paragraphe de note, on remonte au bloc (p/li/aside) qui
// contient réellement le texte de la note.
function texteNoteCible(el) {
  if (!el) return "";
  let bloc = el;
  const t = (el.textContent || "").trim();
  if (el.tagName === "A" || t.length <= 3) {
    bloc = (el.closest && el.closest("li, p, aside, dd, td, div.footnote, .note")) || el.parentElement || el;
  }
  return (bloc.textContent || "").replace(/\s+/g, " ").trim();
}
function baliserNotes(doc, corps, notesArr, idMap, attente) {
  if (!corps || !corps.querySelectorAll) return;
  const estNum = (t) => {
    const n = (t || "").trim().replace(/[\[\]()]/g, "");
    return /^\d{1,4}$/.test(n) || /^[*†‡§¶+]+$/.test(n);
  };
  // Contenus candidats (notes courtes) repérés par leur id.
  corps.querySelectorAll("[id]").forEach((el) => {
    const id = el.id; if (!id || idMap[id] != null) return;
    const txt = texteNoteCible(el);
    if (txt && txt.length <= 2000) idMap[id] = txt;
  });
  // Renvois : éléments marqués noteref, puis liens vers une ancre au texte court.
  const refs = [];
  corps.querySelectorAll("*").forEach((el) => {
    let ty = (el.getAttribute("epub:type") || "");
    try { ty += " " + (el.getAttributeNS("http://www.idpf.org/2007/ops", "type") || ""); } catch (e) {}
    ty = (ty + " " + (el.getAttribute("role") || "")).toLowerCase();
    if (/noteref/.test(ty)) refs.push(el);
  });
  corps.querySelectorAll("a[href]").forEach((a) => {
    if (refs.indexOf(a) >= 0) return;
    const href = a.getAttribute("href") || "";
    if (href.includes("#") && estNum(a.textContent)) refs.push(a);
  });
  refs.forEach((el) => {
    const cible = (el.closest && el.closest("sup")) || el;
    if (!cible.parentNode) return;
    const a = (el.matches && el.matches("a[href]")) ? el
            : (el.querySelector ? el.querySelector("a[href]") : null);
    const fragId = ((a && a.getAttribute("href")) || "").split("#")[1] || "";
    let num = (cible.textContent || "").replace(/[\s\[\]()]/g, "").trim();
    if (!num) num = String(notesArr.length + 1);
    const noteId = notesArr.length;
    const note = { num, texte: "" };
    if (fragId) {
      let tgt = null;
      try { tgt = corps.querySelector("#" + cssEchappe(fragId)); } catch (e) {}
      if (!tgt && doc.getElementById) tgt = doc.getElementById(fragId);
      if (tgt) {
        note.texte = nettoyerNote(texteNoteCible(tgt));
        // Retire la DÉFINITION de la note du flux de lecture (sinon elle est lue
        // en plein texte, ex. « En français dans le texte. (N.d.T.) » répété). On
        // ne supprime que si le bloc EST essentiellement la note (pas un paragraphe
        // de récit qui contiendrait une ancre).
        const bloc = (tgt.closest && tgt.closest("li, aside, p, div, dd")) || tgt;
        const txtBloc = (bloc.textContent || "").replace(/\s+/g, " ").trim();
        if (bloc.parentNode && note.texte && txtBloc && txtBloc.length <= note.texte.length + 40) {
          bloc.parentNode.removeChild(bloc);
        }
      } else attente.push({ noteId, fragId });
    }
    notesArr.push(note);
    cible.parentNode.replaceChild(doc.createTextNode(marqueNote(noteId)), cible);
  });
  // Ménage final : retire les blocs de DÉFINITION de notes (epub:type ou classe
  // « footnote / endnote / rearnote ») restés dans le corps — sinon ils sont lus en
  // plein texte (ex. « En français dans le texte. (N.d.T.) » répété). Leur contenu a
  // déjà été capté dans les notes. Les liens bidirectionnels empêchent parfois leur
  // retrait par id ; ce filtre structurel les attrape de façon fiable.
  corps.querySelectorAll("aside, p, li, div, section").forEach((el) => {
    let ty = (el.getAttribute("epub:type") || "");
    try { ty += " " + (el.getAttributeNS("http://www.idpf.org/2007/ops", "type") || ""); } catch (e) {}
    ty = (ty + " " + (typeof el.className === "string" ? el.className : "")).toLowerCase();
    if (/(^|[\s_-])(foot|end|rear)note/.test(ty) && el.parentNode) el.parentNode.removeChild(el);
  });
}

function texteAvecSeparateurs(el) {
  const clone = el.cloneNode(true);
  retirerAppelsNote(clone);              // enlève les appels de note (exposants 13, liens…)
  clone.querySelectorAll("br").forEach((b) => b.replaceWith(" "));
  appliquerCasse(clone);                 // reproduit les capitales/petites capitales
  clone.querySelectorAll(
    "p, div, h1, h2, h3, h4, h5, h6, li, blockquote, tr, section, article, figcaption"
  ).forEach((b) => b.append("\n"));
  return clone.textContent;
}
  // État de casse (text-transform / petites capitales) lu dans le CSS de l'EPUB.
  function preparerCasse(cssText) { carteCasse = construireCarteCasse(cssText); }
  function reinitCasse() { carteCasse = null; }

  window.Chargeur = {
    construireTOC, aTOCReelle, categorie,
    extraireLivre, tokeniserChapitres, preparerCasse, reinitCasse,
    normTitre,
  };
})();
