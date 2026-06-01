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
  coefAccel: 1,      // accélération max visée (×1 = constante, jusqu'à ×3)
  multAccel: 1,      // multiplicateur d'accélération courant (1 → coefAccel)
  intervalleAccel: 10, // secondes entre deux hausses de +0,1×
  elan: 1,           // « momentum » : <1 juste après une pause, remonte vers 1
  orpActif: true,
  bionic: false,     // lecture bionic (début des mots en gras)
  dialoguesEffets: [], // effets dialogues actifs : "elocution" "multicolore" "italique" "fondu"
  couleurParMot: null, // Map index mot -> couleur (multicolore, calculée au chargement)
  modeleId: "default", // modèle de lecture actif (groupement + rythme + ORP + bionic)
  modele: null,        // objet modèle courant (défini au démarrage)
};
// Un effet de dialogue est-il actif ?
function effetDialogue(nom) { return (etat.dialoguesEffets || []).indexOf(nom) >= 0; }

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
    await sauverLivre(livre);
  }
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
  const apercu = tokeniserChapitres(chapitresTexte, etat.modele.decouper);
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
  carteCasse = null;
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
  carteCasse = null;
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
    const livre = ePub(buffer);
    await livre.ready;
    // Lit le CSS du livre pour reproduire les transformations de casse
    // (titres en petites capitales / majuscules), fidèlement au rendu d'origine.
    carteCasse = null;
    try {
      if (window.JSZip) {
        const zip = await JSZip.loadAsync(buffer);
        const fcss = Object.keys(zip.files).filter((f) => /\.css$/i.test(f));
        const css = (await Promise.all(fcss.map((f) => zip.files[f].async("string")))).join("\n");
        carteCasse = construireCarteCasse(css);
      }
    } catch (e) { carteCasse = null; }
    const { chapitresTexte, notes } = await extraireLivre(livre);
    const apercu = tokeniserChapitres(chapitresTexte, etat.modele.decouper);
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
  retokeniser();
  remplirSelectChapitres();
  placerMarqueursChapitres();
  demarrerLecture();
}

// Texte de démo (pour tester sans EPUB)
const TEXTE_DEMO = `La réception avait eu lieu dans la demeure de Lucinda Joffrey. Sir Richard était absent. Un diplomate de sa stature n’aurait jamais toléré un amusement aussi frivole. Les soirées d’anguille électrique faisaient fureur à Londres depuis peu. Cependant, en raison de la rareté de ces créatures, les fêtes privées étaient rares. En général, elles se tenaient dans des théâtres où quelques heureux élus étaient sélectionnés pour monter sur scène et rencontrer l’anguille, être électrocutés et se convulser comme des pantins articulés pour le plus grand plaisir du public.
— Le record est de quarante-deux personnes d’un coup! l’assura Caroline.
Les yeux écarquillés et brillants, elle observait la créature dans l’aquarium.
— Vraiment?
C’était l’animal le plus singulier qu’il avait jamais vu, sans pour autant être saisissant. Mesurant près de trois pieds de long, avec de petits yeux ronds ternes, un corps trapu et une tête plate, il semblait avoir été modelé dans l’argile par un sculpteur débutant. Il n’avait rien de commun avec les petites anguilles souples et rapides que l’on trouvait sur les marchés. Quoi qu’il en soit, il ne semblait pas capable d’assommer quarante-deux personnes à la fois.
Il n’avait aucune grâce, à part une mince nageoire qui courait tout le long de son ventre et ondulait comme un rideau de mousseline sous la brise. Lord John fit part de son observation à l’honorable Caroline, qui l’accusa d’être un poète.
— Un poète? dit une voix amusée derrière eux. Les talents de notre galant major ne connaissent-ils donc aucune limite?
Lord John se retourna en réprimant une grimace et en affichant un sourire courtois. Il s’inclina devant Edwin Nicholls.`;

// Chapitre 2 inventé, riche en dialogues (test chapitrage + annotations).
const TEXTE_DEMO2 = `Le lendemain matin, une brume épaisse montait de la Tamise et noyait les quais d’un voile gris. Lord John remonta le col de son manteau et pressa le pas vers Whitehall.
— Vous êtes en retard, lança Caroline sans même se retourner.
— La faute à ce brouillard, répondit-il. On n’y voit pas à dix pas.
— Toujours une excuse !
— Ce n’est pas une excuse, c’est un fait.
Elle finit par lui faire face, un sourire moqueur au coin des lèvres.
— Et que comptez-vous faire de votre fameuse anguille ? demanda-t-elle.
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
  etat.nomLivre = "Démo";
  etat.titreLivre = "Texte de démo";
  etat.progression = 0;
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
  const fusionne = fusionnerPagesGarde(reparti);
  // Nettoyage du drapeau interne avant stockage
  fusionne.forEach((c) => { delete c.garde; });

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
      if (!chapAjoute) {
        chapitres.push({ titre: ch.titre || "Chapitre", debut: mots.length });
        chapAjoute = true;
      }
      debuts.add(mots.length);
      for (const w of propres) mots.push(w);
    });
  });
  if (chapitres.length === 0) chapitres.push({ titre: "Début", debut: 0 });
  return { mots, chapitres, debuts, refs };
}

// (Re)tokenise le livre courant avec le modèle actif, en conservant la
// position relative (progression) de lecture.
function retokeniser() {
  const { mots, chapitres, debuts, refs } = tokeniserChapitres(etat.chapitresTexte, etat.modele.decouper);
  etat.mots = mots;
  etat.chapitres = chapitres;
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
  if (effetDialogue("multicolore")) calculerLocuteurs();
  const total = Math.max(1, etat.mots.length);
  etat.index = Math.min(Math.round((etat.progression || 0) * (total - 1)), total - 1);
  if (etat.index < 0 || !isFinite(etat.index)) etat.index = 0;
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
function baliserNotes(doc, corps, notesArr, idMap, attente) {
  if (!corps || !corps.querySelectorAll) return;
  const estNum = (t) => {
    const n = (t || "").trim().replace(/[\[\]()]/g, "");
    return /^\d{1,4}$/.test(n) || /^[*†‡§¶+]+$/.test(n);
  };
  // Contenus candidats (notes courtes) repérés par leur id.
  corps.querySelectorAll("[id]").forEach((el) => {
    const id = el.id; if (!id || idMap[id] != null) return;
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
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
      if (tgt) note.texte = nettoyerNote(tgt.textContent);
      else attente.push({ noteId, fragId });
    }
    notesArr.push(note);
    cible.parentNode.replaceChild(doc.createTextNode(marqueNote(noteId)), cible);
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
  const { texte, nb } = etat.modele.chunk(etat.index);
  etat.nbCourant = nb;
  if (!texte) return;

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
  motAffiche.classList.toggle("dlg-italique", enDial && effetDialogue("italique"));
  motAffiche.style.setProperty("--couleur-dialogue", couleur || "");
  motAffiche.classList.toggle("dlg-couleur", !!couleur);
  // Fondu : on relance l'animation à chaque chunk (retire/rajoute la classe).
  if (enDial && effetDialogue("fondu")) {
    motAffiche.classList.remove("dlg-fondu");
    void motAffiche.offsetWidth;            // force le redémarrage de l'animation
    motAffiche.classList.add("dlg-fondu");
  } else {
    motAffiche.classList.remove("dlg-fondu");
  }
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
          html += '<span class="marque-note' + accent + '" aria-hidden="true">' + mk.car + "</span>";
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

// --- Multicolore : détection du locuteur de chaque réplique ---
// Verbes de parole courants (incise : « dit Margaret », « Margaret s'écria »).
const VERBES_PAROLE = /^(dit|dis|dirent|r[ée]pond(it|irent)|r[ée]pliqu(a|èrent)|s[' ]?[ée]cri(a|èrent)|demand(a|èrent)|murmur(a|èrent)|souffl(a|èrent)|lan[çc](a|èrent)|ajout(a|èrent)|repr(it|irent)|s[' ]?exclam(a|èrent)|s[' ]?[ée]tonn(a|èrent)|soupir(a|èrent)|cri(a|èrent)|fit|firent|insist(a|èrent)|pours(uivit|uivirent)|chuchot(a|èrent)|gémit|grogn(a|èrent)|interrog(ea|èrent)|questionn(a|èrent)|conclu(t|rent)|affirm(a|èrent)|d[ée]clar(a|èrent)|expliqu(a|èrent)|raill(a|èrent)|ordonn(a|èrent)|protest(a|èrent)|balbut(ia|ièrent)|annon[çc](a|èrent)|rétorqu(a|èrent)|tonn(a|èrent))$/i;
function motNu(m) { return (m || "").replace(/[^\p{L}'-]/gu, ""); }
// Suffixe pronominal d'inversion (« répondit-il », « demanda-t-elle », « dit-on »…).
const SUFFIXE_PRON = /-(t-)?(il|elle|on|je|tu|nous|vous|ils|elles|le|la|les|moi|toi|lui|leur)$/i;
// Le mot est-il un verbe de parole, même avec un sujet inversé accolé ?
function estVerbeParole(mot) {
  let m = (mot || "").replace(/[^\p{L}'’-]/gu, "").replace(/[’]/g, "'");
  if (VERBES_PAROLE.test(m)) return true;
  const radical = m.replace(SUFFIXE_PRON, "");
  return radical !== m && VERBES_PAROLE.test(radical);
}
// Article INDÉFINI introduisant un NOUVEAU personnage (« un homme », « une voix »,
// « des soldats ») → locuteur tiers. À ne pas confondre avec un pronom de reprise
// (« il », « elle ») ou un défini/possessif (« le », « son »…) qui désignent un
// personnage déjà présent (on garde alors sa couleur).
const ARTICLE_INDEFINI = /^(un|une|des|d')$/i;
// Cherche le locuteur d'une réplique commençant au mot `deb`. Renvoie un objet
// { nom, tiers } : `nom` = identifiant du locuteur ; `tiers` = true si c'est un
// locuteur DESCRIPTIF (« un homme », « une voix » → intervenant de passage), false
// pour un nom propre (personnage récurrent).
//   - APRÈS la réplique : verbe de parole + nom propre/groupe descriptif ;
//   - AVANT : à la fin de la phrase précédente (« Margaret s'écria : »).
function locuteurDeReplique(deb) {
  const mots = etat.mots;
  let fin = deb + 1; while (fin < mots.length && !estDebutPhrase(fin)) fin++;
  // Le mot précédent finit-il par une fin forte ? (l'incise qui suit démarre en minuscule)
  const finForte = /[?!…][”»"')\]]*$/.test((mots[fin - 1] || "").trim());
  // APRÈS la réplique : un nom propre, sinon un groupe descriptif (déterminant + nom).
  const limite = Math.min(fin + 8, mots.length);
  for (let k = fin; k < limite; k++) {
    const a = motNu(mots[k]), b = motNu(mots[k + 1] || "");
    if (VERBES_PAROLE.test(a) && /\p{Lu}/u.test((b[0] || ""))) return { nom: b, tiers: false };   // « dit Margaret »
    if (/\p{Lu}/u.test((a[0] || "")) && VERBES_PAROLE.test(b)) return { nom: a, tiers: false };   // « Margaret dit »
    // Locuteur descriptif : un VERBE DE PAROLE (connu, ou inconnu juste après une
    // fin forte ? ! …) immédiatement suivi d'un déterminant + nom commun
    // (« ricana un homme », « lança une voix »). On n'accepte ce cas que SUR LA
    // CONTINUATION de la réplique courante (k = fin), pas dans une réplique suivante.
    if (k === fin) {
      const estV = VERBES_PAROLE.test(a) || (finForte && estVerbeParole(mots[k]) === false && /^\p{Ll}/u.test(a));
      // Tiers UNIQUEMENT si le verbe est suivi d'un ARTICLE INDÉFINI (« un homme »).
      // « il/elle » ou un défini → reprise d'un personnage connu, pas un tiers.
      if (estV && ARTICLE_INDEFINI.test((mots[k + 1] || "").replace(/[^\p{L}']/gu, ""))) {
        const nomCommun = motNu(mots[k + 2] || "");
        if (nomCommun) return { nom: (a + " " + nomCommun).toLowerCase(), tiers: true };
      }
    }
    if (estDebutPhrase(k + 1) && k > fin) break;       // on ne déborde pas sur la réplique suivante
  }
  // AVANT la réplique : nom propre autour d'un verbe de parole.
  let p = deb - 1; while (p >= 0 && !estDebutPhrase(p)) p--;
  for (let k = deb - 1; k >= Math.max(0, p); k--) {
    if (VERBES_PAROLE.test(motNu(mots[k]))) {
      const av = motNu(mots[k - 1] || ""), ap = motNu(mots[k + 1] || "");
      if (/\p{Lu}/u.test((av[0] || ""))) return { nom: av, tiers: false };
      if (/\p{Lu}/u.test((ap[0] || ""))) return { nom: ap, tiers: false };
    }
  }
  return { nom: "", tiers: false };
}
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
  ],
  // Mêmes palettes que Midnight, déclinées selon le contraste de chaque thème :
  black: [   // Deep Black : teintes franches (échangées depuis Sépia)
    { nom: "Néon",      c: ["#bc4824", "#8f3d8f", "#278647"] },
    { nom: "Cosmos",    c: ["#2e6f9e", "#309161", "#b67820"] },
    { nom: "Spectre",   c: ["#358d35", "#c48c1c", "#b62d20"] },
  ],
  mono: [    // Dark Mono : teintes douces (désaturées, saturation +15 %)
    { nom: "Galet",     c: ["#b07867", "#987474", "#77914d"] },
    { nom: "Brouillard",c: ["#719eac", "#8da36b", "#bc946b"] },
    { nom: "Lichen",    c: ["#8da36b", "#b8a575", "#b9564e"] },
  ],
  sepia: [   // Sépia : teintes vives + claires (échangées depuis Deep Black)
    { nom: "Terre",     c: ["#e27e5d", "#cd67b8", "#98d82f"] },
    { nom: "Ardoise",   c: ["#67c2de", "#a8d85e", "#eaa966"] },
    { nom: "Automne",   c: ["#a8d85e", "#e5c371", "#eb5045"] },
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
  return { nom: "Accentuation", accent: true, c: [v(0), v(-60), v(60)] };
}
// Couleurs courantes de la palette PERSONNALISÉE (Voix 1/2/3), mémorisées.
let couleursPerso = ["#74a228", "#aa4521", "#a22878"];
// Applique la palette choisie au thème courant. `nom` = nom d'une palette du thème,
// ou "perso" pour la palette personnalisée (3 roues chromatiques).
// Applique une palette. `theme` = thème SOURCE de la palette (peut différer du
// thème de fond : palette et thème sont indépendants). Par défaut, le thème mémorisé.
function appliquerPaletteDialogue(nom, theme) {
  if (nom === "perso") {
    etat.paletteDialogue = "perso";
    [COUL_PRINCIPAL, COUL_SEC1, COUL_SEC2] = couleursPerso;
  } else {
    const src = theme || etat.paletteTheme || themeActif();
    const liste = palettesDuTheme(src);
    let p = liste.find((x) => x.nom === nom);
    if (!p) { p = palettesDuTheme(themeActif())[0]; etat.paletteTheme = themeActif(); }
    else etat.paletteTheme = src;
    etat.paletteDialogue = p.nom;
    [COUL_PRINCIPAL, COUL_SEC1, COUL_SEC2] = p.c;
  }
  try {
    localStorage.setItem("bookreeder-palette-dialogue", etat.paletteDialogue);
    localStorage.setItem("bookreeder-palette-theme", etat.paletteTheme || "");
  } catch (e) {}
  if (etat.couleurParMot) calculerLocuteurs();   // recalcule avec les nouvelles couleurs
  if (!ecranLecture.classList.contains("cache")) afficherChunk();
  majBoutonPalette();
}
// Couleurs effectives de la palette courante (pour le bouton + les pastilles).
function couleursPaletteCourante() {
  if (etat.paletteDialogue === "perso") return couleursPerso;
  const liste = palettesDuTheme(etat.paletteTheme || themeActif());
  const p = liste.find((x) => x.nom === etat.paletteDialogue) || liste[0];
  return p.c;
}
// Met à jour le bouton hybride (nom + 3 pastilles de la palette courante).
function majBoutonPalette() {
  const nom = etat.paletteDialogue === "perso" ? "Perso" : (etat.paletteDialogue || "Corail");
  const elNom = $("btn-palette-nom"); if (elNom) elNom.textContent = nom;
  const elPast = $("btn-palette-pastilles");
  if (elPast) elPast.innerHTML = couleursPaletteCourante().map((col) => '<span class="pastille-mini" style="background:' + col + '"></span>').join("");
}
const NOMS_THEMES = { midnight: "Midnight", mono: "Dark Mono", black: "Deep Black", sepia: "Sépia" };
const ORDRE_THEMES = ["midnight", "mono", "black", "sepia"];
let paletteThemeApercu = "midnight";   // thème dont on visualise les palettes (≠ thème de fond éventuellement)
// Rend la section « Palette du thème X » du thème en aperçu.
function rendrePaletteListe() {
  $("palette-titre-theme").textContent = "Palette " + (NOMS_THEMES[paletteThemeApercu] || "");
  const liste = palettesDuTheme(paletteThemeApercu);
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  $("palette-liste").innerHTML = liste.map((p) => {
    // « choisie » seulement si c'est la palette active ET du même thème source
    // (« Accentuation » est commune à tous les thèmes).
    const memeSource = p.nom === "Accentuation" || (etat.paletteTheme || themeActif()) === paletteThemeApercu;
    const sel = (etat.paletteDialogue === p.nom && memeSource) ? " choisie" : "";
    return '<button class="palette-item' + sel + '" data-nom="' + esc(p.nom) + '"' +
      ' data-couleurs="' + p.c.join(",") + '">' +
      '<div class="palette-tete"><b>' + esc(p.nom) + '</b>' +
      '<span class="pastilles-mini">' + p.c.map((c) => '<span class="pastille-mini" style="background:' + c + '"></span>').join("") + '</span></div>' +
      '</button>';
  }).join("");
  rendrePerso();
  majApercuHaut();   // l'aperçu du haut reflète la palette active
}
// Met à jour le bloc d'aperçu unique en haut : 3 répliques colorées (une par
// couleur de la palette) ; les incises (« dit-elle », « répondit Claire »)
// gardent la couleur du texte (non colorées).
function majApercuHaut(c) {
  const cols = c || couleursPaletteCourante();
  const el = $("palette-apercu-haut");
  if (el) el.innerHTML =
    '<div><span style="color:' + cols[0] + '">— Vous voyez ?</span> dit-elle.</div>' +
    '<div><span style="color:' + cols[1] + '">— Oui, tout à fait !</span> répondit Claire. <span style="color:' + cols[1] + '">C\'est stupéfiant…</span></div>' +
    '<div><span style="color:' + cols[2] + '">— Mais que faites vous ici ?</span></div>';
}
// Rend la carte « Mes couleurs » (pastilles) selon les 3 roues.
function rendrePerso() {
  $("palette-perso-pastilles").innerHTML = couleursPerso.map((c) => '<span class="pastille-mini" style="background:' + c + '"></span>').join("");
  $("palette-item-perso").classList.toggle("choisie", etat.paletteDialogue === "perso");
}
function ouvrirPalette() {
  paletteThemeApercu = themeActif();         // on démarre sur le thème de fond actuel
  rendrePaletteListe();
  $("panneau-palette").classList.remove("cache");
}
function fermerPalette() { $("panneau-palette").classList.add("cache"); }
function naviguerThemePalette(pas) {
  const i = ORDRE_THEMES.indexOf(paletteThemeApercu);
  paletteThemeApercu = ORDRE_THEMES[(i + pas + ORDRE_THEMES.length) % ORDRE_THEMES.length];
  rendrePaletteListe();
}
$("btn-palette").addEventListener("click", ouvrirPalette);
$("btn-fermer-palette").addEventListener("click", fermerPalette);
$("panneau-palette").addEventListener("click", (e) => { if (e.target.id === "panneau-palette") fermerPalette(); });
$("palette-theme-prec").addEventListener("click", () => naviguerThemePalette(-1));
$("palette-theme-suiv").addEventListener("click", () => naviguerThemePalette(1));
// Choix d'une palette : on applique ses couleurs SANS changer le thème de fond
// (palette et thème sont indépendants). On retient le thème source de la palette.
$("palette-liste").addEventListener("click", (e) => {
  const it = e.target.closest(".palette-item");
  if (!it) return;
  appliquerPaletteDialogue(it.dataset.nom, paletteThemeApercu);
  rendrePaletteListe();
});
// Aperçu dynamique au survol (PC) : le bloc du haut montre la palette survolée.
$("palette-liste").addEventListener("pointerover", (e) => {
  const it = e.target.closest(".palette-item");
  if (it && it.dataset.couleurs) majApercuHaut(it.dataset.couleurs.split(","));
});
$("palette-liste").addEventListener("pointerleave", () => majApercuHaut());
// Sélection de la palette personnalisée (clic sur sa carte).
$("palette-item-perso").addEventListener("click", () => { appliquerPaletteDialogue("perso"); rendrePaletteListe(); });
$("palette-item-perso").addEventListener("pointerover", () => majApercuHaut(couleursPerso));
$("palette-item-perso").addEventListener("pointerleave", () => majApercuHaut());
// Roues chromatiques Voix 1/2/3 : mettent à jour la palette perso en direct.
["voix1-couleur", "voix2-couleur", "voix3-couleur"].forEach((id, i) => {
  $(id).addEventListener("input", (e) => {
    couleursPerso[i] = e.target.value;
    try { localStorage.setItem("bookreeder-perso-voix", JSON.stringify(couleursPerso)); } catch (err) {}
    appliquerPaletteDialogue("perso");   // bascule sur perso et applique
    rendrePaletteListe();                // met à jour la sélection (retire .choisie des autres)
    $("palette-item-perso").scrollIntoView({ block: "nearest" });   // focus sur « Mes couleurs »
  });
});
// Pendant l'ouverture d'une roue chromatique native, ne pas assombrir l'arrière-plan
// (on rend le fond du panneau transparent le temps de la sélection). Vaut pour TOUTES
// les roues : Mes couleurs (palette), couleur d'accentuation, police, début bionic.
document.querySelectorAll('input[type="color"]').forEach((inp) => {
  inp.addEventListener("focus", () => document.body.classList.add("roue-ouverte"));
  inp.addEventListener("blur", () => document.body.classList.remove("roue-ouverte"));
});
// Construit etat.couleurParMot. Principe « ping-pong » : dans un échange, les
// répliques alternent entre 2 interlocuteurs (tour à tour). Les incises détectées
// (« dit Margaret ») ancrent un nom sur sa parité ; le personnage principal (le
// plus cité du livre) garde sa couleur partout.
function calculerLocuteurs() {
  const mots = etat.mots;
  const map = new Map();
  if (!mots || !mots.length) { etat.couleurParMot = map; return; }

  // Début de PARAGRAPHE (bloc), pour délimiter une réplique entière même si elle
  // contient plusieurs phrases ou une incise médiane.
  const debutBloc = (i) => i <= 0 || (etat.debutsPhrase && etat.debutsPhrase.has(i));

  // 1) Liste des répliques + locuteur détecté (si incise) ; compte global des noms.
  //    Une réplique va du tiret jusqu'au prochain DÉBUT DE PARAGRAPHE → elle peut
  //    donc englober plusieurs phrases (incise médiane + suite de la réplique).
  const repliques = [];   // { deb, fin, nom }
  const compte = {};
  for (let i = 0; i < mots.length; i++) {
    const estRep = debutBloc(i) && DEBUT_REPLIQUE.test((mots[i] || "").trimStart());
    if (!estRep) continue;
    let fin = i + 1; while (fin < mots.length && !debutBloc(fin)) fin++;
    const loc = locuteurDeReplique(i);
    const nom = normTitre(loc.nom);
    if (nom && !loc.tiers) compte[nom] = (compte[nom] || 0) + 1;   // seuls les noms propres comptent pour « principal »
    repliques.push({ deb: i, fin, nom, tiers: loc.tiers });
    i = fin - 1;
  }
  if (!repliques.length) { etat.couleurParMot = map; return; }

  // 2) Personnage principal = nom le plus cité.
  let principal = "", max = 0;
  for (const n in compte) if (compte[n] > max) { max = compte[n]; principal = n; }

  // 3) Découpe en CONVERSATIONS (répliques rapprochées) ; dans chaque bloc,
  //    alternance par tour entre 2 slots (0/1). Un nom détecté « ancre » sa parité.
  const GAP_MAX = 80;   // mots de narration max entre 2 répliques d'un même échange
  let b = 0;
  while (b < repliques.length) {
    let e = b;
    while (e + 1 < repliques.length && repliques[e + 1].deb - repliques[e].fin <= GAP_MAX) e++;
    // Alternance ping-pong entre 2 interlocuteurs ; les répliques « tierces »
    // (locuteur descriptif : « un homme », « une voix ») sont mises À PART et ne
    // comptent pas dans l'alternance (sinon elles décaleraient les couleurs).
    const slotNom = ["", ""];
    let par = 0;
    const parite = [];                          // parité (0/1) de chaque réplique non-tierce
    for (let k = b; k <= e; k++) {
      if (repliques[k].tiers) { parite[k] = -1; continue; }   // -1 = tiers
      parite[k] = par;
      if (repliques[k].nom && !slotNom[par]) slotNom[par] = repliques[k].nom;
      par = 1 - par;                            // alterne au tour suivant
    }
    const slot0Princ = slotNom[0] && slotNom[0] === principal;
    const slot1Princ = slotNom[1] && slotNom[1] === principal;
    const couleurSlot = (p) => {
      if (p === -1) return COUL_SEC2;                       // tiers → 3e couleur
      if (slotNom[p] && slotNom[p] === principal) return COUL_PRINCIPAL;
      const autrePrinc = p === 0 ? slot1Princ : slot0Princ;
      if (autrePrinc) return COUL_SEC1;                    // l'autre est le principal
      return p === 0 ? COUL_SEC1 : COUL_SEC2;              // 2 secondaires en alternance
    };
    for (let k = b; k <= e; k++) {
      const c = couleurSlot(parite[k]);
      const r = repliques[k];
      // Colore toute la réplique, SAUF les phrases-incises internes (« dit une
      // voix amusée derrière eux. ») : une phrase qui n'est pas le tout début de
      // la réplique et qui commence par un verbe de parole reste en couleur normale.
      const inc = zonesIncise(r.deb, r.fin);     // mots à NE PAS colorer (incises)
      for (let x = r.deb; x < r.fin; x++) if (!inc.has(x)) map.set(x, c);
    }
    b = e + 1;
  }
  etat.couleurParMot = map;
}
// Renvoie l'ensemble des indices de mots [deb, fin) qui appartiennent à une
// INCISE de narration (à NE PAS colorer), au sein d'une réplique. On découpe la
// réplique en SEGMENTS sur 3 frontières : début de phrase, fin forte (? ! …) et
// VIRGULE. Un segment est une incise s'il commence par un verbe de parole
// (« lança Caroline », « répondit-il »), ou s'il suit une fin forte en minuscule.
function zonesIncise(deb, fin) {
  const set = new Set();
  const finSegment = (i) => {
    const m = (etat.mots[i] || "").trim();
    return /[?!…][”»"')\]]*$/.test(m) || /,$/.test(m.replace(/[”»"')\]]+$/, ""));
  };
  let s = deb;                       // début du segment courant
  while (s < fin) {
    // Avance jusqu'à : un début de phrase (exclu du segment) ou un mot à
    // ponctuation forte/virgule (inclus, il termine le segment).
    let e = s;
    while (e < fin) {
      if (e > s && estDebutPhrase(e)) { e--; break; }   // début de phrase → segment = [s..e-1]
      if (finSegment(e)) break;                          // ? ! … , → ce mot termine le segment
      e++;
    }
    if (e >= fin) e = fin - 1;
    // Le segment [s..e] est-il une incise ?
    const prem = (etat.mots[s] || "").replace(/^[^\p{L}]+/u, "");
    const motPrec = s > deb ? (etat.mots[s - 1] || "").trim() : "";
    const apresVirgule = /,$/.test(motPrec.replace(/[”»"')\]]+$/, ""));
    const apresFinForte = /[?!…][”»"')\]]*$/.test(motPrec);
    let incise = false;
    // (a) verbe de parole dans les 3 premiers mots du segment (« lança Caroline »)
    for (let k = s; k <= Math.min(e, s + 2); k++) { if (estVerbeParole(etat.mots[k])) { incise = true; break; } }
    // (b) RÈGLE TYPO : segment NON initial qui démarre en MINUSCULE juste après
    //     une FIN FORTE (? ! …) → c'est forcément une incise (« ricana un homme… »),
    //     même si le verbe est inconnu. (Après une simple virgule c'est ambigu —
    //     « , c'est un fait » n'est pas une incise — donc on exige le verbe, cas (a).)
    if (!incise && s > deb && apresFinForte && prem && /\p{Ll}/u.test(prem[0])) incise = true;
    if (incise) for (let x = s; x <= e; x++) set.add(x);
    s = e + 1;
  }
  return set;
}

// Décélération d'élocution (DIALOGUES) : on ralentit progressivement les derniers
// mots AVANT une ponctuation, pour imiter le débit parlé.
//   virgule , ; : → 2 derniers mots : +20%, +40%
//   point .        → 3 derniers mots : +20%, +40%, +60%
//   interrogation ?→ 2 derniers mots : +20%, +40%
//   suspension …   → 3 derniers mots : +20%, +40%, +60%
//   exclamation !  → aucun (débit direct)
// Renvoie le facteur multiplicateur (1 = normal) pour le mot d'index i.
const RE_FIN_NETTE = /["»”'’)\]]*$/;
function coefElocution(i) {
  if (i < 0 || i >= etat.mots.length) return 1;
  if (!dansDialogue(i)) return 1;               // narration : rythme inchangé
  // Cherche, à partir de i, le 1er mot porteur d'une ponctuation de fin de groupe.
  let j = i, signe = "";
  for (let k = 0; k < 6 && j < etat.mots.length; k++, j++) {
    const m = (etat.mots[j] || "").replace(RE_FIN_NETTE, "");
    const c = m.slice(-1);
    if ("…".indexOf(c) >= 0 || /[.,;:!?]/.test(c)) { signe = c; break; }
    if (estDebutPhrase(j + 1)) { j = -1; break; }   // fin de phrase atteinte sans ponctuation
  }
  if (j < 0 || !signe) return 1;
  // Paliers rangés du mot PORTEUR de la ponctuation (le plus ralenti) vers les
  // précédents : index 0 = mot ponctué (+40% ou +60%), 1 = mot d'avant, etc.
  let paliers;
  if (signe === "!") paliers = [];                        // direct
  else if (signe === "?") paliers = [0.4, 0.2];           // 2 mots
  else if (signe === "," || signe === ";" || signe === ":") paliers = [0.4, 0.2]; // 2 mots
  else paliers = [0.6, 0.4, 0.2];                         // . ou … : 3 mots
  const dist = j - i;                            // 0 = le mot porteur de la ponctuation
  if (dist < 0 || dist >= paliers.length) return 1;
  return 1 + paliers[dist];
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

  // Noms propres (majuscule en milieu de phrase) : 500 ms mini par nom propre.
  const planNom = plancherNomPropre(debut, fin);
  if (planNom > 0) mot = Math.max(mot, planNom);
  const majuscule = planNom > 0;   // sert aussi à la reprise d'élan plus bas

  // 3) Respirations : ponctuation de fin de groupe OU ouverture de réplique.
  //    On ne CUMULE pas fin de phrase + entrée en dialogue (sinon pause très
  //    longue) : on garde la plus longue des deux.
  const dernier = groupe[groupe.length - 1] || "";
  let pausePonct = 0;
  if (/[.!?…]["»”'’)\]]*$/.test(dernier)) pausePonct = base * P.pauseFinPhrase;  // fin de phrase
  else if (/[,;:]["»”'’)\]]*$/.test(dernier)) pausePonct = base * P.pauseVirgule; // virgule, etc.
  const suivant = etat.mots[fin];
  const pauseRep = (suivant && DEBUT_REPLIQUE.test(suivant)) ? base * P.pauseReplique : 0; // échanges
  let pause = Math.max(pausePonct, pauseRep);
  // Respiration de fin de bloc/paragraphe (titre sans ponctuation, etc.)
  if (pause === 0 && etat.debutsPhrase && etat.debutsPhrase.has(fin)) pause += base * P.pauseFinPhrase;

  // 4) Mise à jour de l'élan pour le PROCHAIN groupe : après une vraie pause on
  //    repart doucement, sinon on accélère par paliers (pas d'à-coup).
  if (pause >= base * P.pauseFinPhrase) etat.elan = P.elanGrossePause;  // grosse pause
  else if (pause > 0 || majuscule) etat.elan = P.elanPauseMoyenne;      // pause moyenne
  else etat.elan = Math.min(1, etat.elan + P.elanAccel);                // accélération

  // Décélération d'élocution (dialogues) : active seulement si l'effet « élocution »
  // est choisi. On applique le plus fort coefficient parmi les mots du groupe.
  if (effetDialogue("elocution")) {
    let coefElo = 1;
    for (let k = debut; k < fin; k++) coefElo = Math.max(coefElo, coefElocution(k));
    mot *= coefElo;
  }

  // Le temps de pause est modulé par le coefficient réglable (0,5–4).
  // Plancher absolu : aucun mot ne s'affiche moins de ~Nms (anti-télescopage).
  // Plafond : un mot ne dépasse jamais 2 s, même cumul élocution + pause.
  return Math.min(Math.max(mot + pause * etat.coefPause, P.affichageMin), 2000);
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
  const unite = etat.modele.params.nomPropreMs;
  if (!unite) return 0;
  let n = 0;
  for (let k = debut; k < fin; k++) {
    if (!estDebutPhrase(k) && commenceMajuscule(etat.mots[k])) n++;
  }
  return n * unite * (etat.coefPause / 2);
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
      motMin: 0.6,             // plancher de durée d'un mot (× base × nb mots)
      pauseFinPhrase: 2,       // pause après . ! ? … (× base)
      pauseVirgule: 1,         // pause après , ; : (× base)
      pauseReplique: 1,        // pause avant une réplique de dialogue (× base)
      plancherDialogue: 1,     // pas de ralentissement de base en dialogue (= narration)
      nomPropreMs: 500,        // 500 ms mini par nom propre @2,0× (cumulés si consécutifs)
      elanGrossePause: 0.65,   // élan après une grosse pause (reprise douce)
      elanPauseMoyenne: 0.82,  // élan après une pause moyenne
      elanAccel: 0.1,          // accélération de l'élan par mot (vers 1), graduelle
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
  const d = etat.modele.delai();
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
  etat.elan = 1;            // repart à pleine cadence
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
  ["btn-lecture", "ep-lecture"].forEach((id) => {
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
}

function basculerLecture() {
  etat.enLecture ? pause() : lecture();
}

// Durée estimée pour finir le chapitre courant, selon les mots RESTANTS
// et la vitesse actuelle. Recalculée à chaque play/pause.
function majDureeChapitre() {
  const el = $("duree-chapitre");
  if (!el || !etat.mots.length) return;
  const { fin } = bornesChapitre();
  const restant = Math.max(0, fin - etat.index);
  const totalMin = restant / etat.vitesse;       // mots ÷ (mots/min) = minutes
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  // Sous 1 h, on n'affiche que les minutes ; au-delà, format XhYYm.
  let txt;
  if (h > 0) txt = `${h}h${String(m).padStart(2, "0")}m`;
  else if (m === 0) txt = "< 0m";         // moins d'une minute
  else txt = `${m}m`;
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
  etat.elan = 1;            // nouvelle position : on repart à pleine cadence
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
  if (im) im.innerHTML = infosLectureHtml(true);

  if (!$("panneau-navigation").classList.contains("cache")) majBarreLivre();
}

// Ligne d'infos de lecture (position % · chapitre [· nb de mots]), partagée par
// le Mode Minimaliste et le Mode Loupe.
function infosLectureHtml(avecMots) {
  const { debut, fin } = bornesChapitre();
  const lenChap = Math.max(1, fin - debut);
  const posChap = Math.min(lenChap, Math.max(0, etat.index - debut));
  const pctChap = (posChap / lenChap) * 100;
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = pctChap.toFixed(1).replace(".", ",") + " % · " + esc(tronquerTitre(chapitreActuel().titre));
  if (avecMots && etat.afficherMots) html += "<br>" + posChap + " / " + lenChap + " mots";  // 2e ligne
  return html;
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
  reglerVitesse(etat.vitesse);
  ajusterCadre();
  appliquerOrp();
  afficherChunk();
  majDureeChapitre();
  if (typeof gererOrientation === "function") gererOrientation(); // paysage → minimaliste
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
    html += `<span data-i="${i}"${cls ? ` class="${cls.trim()}"` : ""}${styleCoul}>${echap(etat.mots[i])}${sup}</span> `;
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
  if (recentrer && prem) prem.scrollIntoView({ block: "center" });
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
function fermerContexte() { if (typeof fermerBulleNote === "function") fermerBulleNote(); $("ecran-contexte").classList.add("cache"); }
$("ctx-recul").addEventListener("click", () => { fermerBulleNote(); etat.index = phrasePrecedente(); rafraichirContexte(true); });
$("ctx-avance").addEventListener("click", () => { fermerBulleNote(); etat.index = phraseSuivante(); rafraichirContexte(true); });
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
//  - CLIC COURT = ferme la loupe et REPREND la lecture rapide (après 1 s) ;
//  - APPUI PROLONGÉ (≈0,5 s) = ferme la loupe SANS relancer la lecture.
function fermerLoupe(relancer) {
  fermerBulleNote();
  fermerContexte();
  afficherChunk();
  if (relancer) { clearTimeout(etat.minuteur); etat.minuteur = setTimeout(lecture, 1000); }
}
(function installerCtxPlay() {
  const btn = $("ctx-play");
  if (!btn) return;
  let timer = null, long = false;
  // Appui long (≈0,5 s) : ferme le mode loupe SANS attendre de relever le doigt
  // (et sans relancer la lecture). Appui court (clic) : reprend la lecture.
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(() => { long = true; fermerLoupe(false); }, 500);
  });
  ["pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
  btn.addEventListener("pointerup", () => clearTimeout(timer));
  btn.addEventListener("click", () => {
    if (long) { long = false; return; }   // déjà fermé par l'appui long
    fermerLoupe(true);
  });
})();
// Bouton loupe (droite) : ouvre la recherche dans le livre.
$("ctx-recherche").addEventListener("click", ouvrirRecherche);
// Bouton message (gauche) : liste toutes les annotations du chapitre.
$("ctx-notes").addEventListener("click", ouvrirAnnotations);

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
function reglerVitesse(v) {
  etat.vitesse = Math.min(800, Math.max(100, v));
  etat.multAccel = 1;       // l'usage des touches réinitialise l'accélération
  demarrerAccel();          // et relance la rampe (10 s à partir de maintenant)
  majVitesseAffichee();
  majDureeChapitre();   // l'estimation dépend de la vitesse
}
$("btn-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 20));
$("btn-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 20));
$("ep-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 20));
$("ep-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 20));

// Retour / avance à la phrase précédente / suivante
$("btn-recul").addEventListener("click", () => deplacer(phrasePrecedente() - etat.index, true));
$("btn-avance").addEventListener("click", () => deplacer(phraseSuivante() - etat.index, true));
// Chapitre précédent / suivant
$("btn-chap-prec").addEventListener("click", () => allerChapitre(-1));
$("btn-chap-suiv").addEventListener("click", () => allerChapitre(1));

$("btn-fermer").addEventListener("click", async () => {
  pause();
  await sauverPosition();
  ecranLecture.classList.add("cache");
  ecranAccueil.classList.remove("cache");
  $("input-fichier").value = "";
  $("message-chargement").textContent = "";
  afficherBibliotheque();
  if (typeof rafraichirBulleLireMoi === "function") rafraichirBulleLireMoi();
});

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
// En Mode Loupe : toucher la ligne d'infos du chapitre ouvre la navigation SANS
// quitter la loupe (on y revient après le choix).
let navDepuisLoupe = false;
$("contexte-infos").addEventListener("click", () => {
  navDepuisLoupe = true;
  $("nav-chapitre").value = etat.chapitres.indexOf(chapitreActuel());
  $("panneau-navigation").classList.remove("cache");
  majBarreLivre();
});

// Panneau d'aide / fonctionnalités (accueil)
$("btn-infos").addEventListener("click", () => $("panneau-infos").classList.remove("cache"));
$("btn-fermer-infos").addEventListener("click", () => $("panneau-infos").classList.add("cache"));

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

// =========================================================
//  Bibliothèque sur l'écran d'accueil
// =========================================================
async function afficherBibliotheque() {
  const conteneur = $("bibliotheque");
  conteneur.innerHTML = "";
  const titre = $("titre-lectures");
  let livres = [];
  try { livres = (await listerLivres()) || []; } catch (e) { if (titre) titre.style.display = "none"; return; }
  livres.sort((a, b) => b.dateAjout - a.dateAjout);
  if (titre) titre.style.display = livres.length ? "block" : "none";
  if (!livres.length) return;

  livres.forEach((livre) => {
    const frac = livre.progression != null ? livre.progression
      : (livre.total ? (livre.index || 0) / livre.total : 0);
    const pct = Math.round(frac * 100);
    const item = document.createElement("div");
    item.className = "item-livre";
    item.innerHTML =
      `<div class="item-infos">` +
        `<span class="item-nom"></span>` +
        `<span class="item-auteur"></span>` +
        `<span class="item-meta">Ajouté le ${formatDate(livre.dateAjout)} · ${pct}%</span>` +
      `</div>` +
      `<button class="item-suppr" title="Retirer">×</button>`;
    // Titre du livre (métadonnées) si dispo, sinon nom de fichier
    item.querySelector(".item-nom").textContent = livre.titre || livre.nom;
    const elAuteur = item.querySelector(".item-auteur");
    if (livre.auteur) elAuteur.textContent = livre.auteur;
    else elAuteur.remove();
    item.querySelector(".item-infos").addEventListener("click", async () => {
      const frais = await lireLivre(livre.id); // position à jour
      ouvrirFiche(frais || livre);
    });
    item.querySelector(".item-suppr").addEventListener("click", async (e) => {
      e.stopPropagation();
      await supprimerLivre(livre.id);
      afficherBibliotheque();
    });
    conteneur.appendChild(item);
  });
}
afficherBibliotheque();
initialiserModeles();

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
function positionnerBulle() {
  const btn = $("btn-infos"), bulle = $("bulle-liremoi");
  if (!btn || !bulle) return;
  const r = btn.getBoundingClientRect();
  bulle.style.top = (r.bottom + 10) + "px";
  bulle.style.right = Math.max(8, window.innerWidth - r.right) + "px";
}
// Masquage permanent (clic sur la bulle ou ouverture du (i)).
function cacherBulleLireMoi() {
  bulleActive = false;
  $("bulle-liremoi").classList.add("cache");
}
// Affiche la bulle si elle est encore active ET qu'on est sur l'accueil.
function rafraichirBulleLireMoi() {
  const bulle = $("bulle-liremoi");
  if (!bulle) return;
  const surAccueil = !ecranAccueil.classList.contains("cache");
  if (bulleActive && surAccueil) { positionnerBulle(); bulle.classList.remove("cache"); }
  else { bulle.classList.add("cache"); }
}
$("btn-infos").addEventListener("click", cacherBulleLireMoi);
$("bulle-liremoi").addEventListener("click", cacherBulleLireMoi);
(function initBulleLireMoi() {
  let vue = null;
  try { vue = localStorage.getItem("bookreeder-vue-version"); } catch (e) {}
  const v = versionApp();
  if (v && vue !== v) {
    try { localStorage.setItem("bookreeder-vue-version", v); } catch (e) {}
    bulleActive = true;
    setTimeout(rafraichirBulleLireMoi, 500);   // laisse le temps à la mise en page
  }
})();

// Réglages : on met en pause et on fait monter la zone de lecture en aperçu (1/3
// haut) pendant que le panneau occupe les 2/3 du bas ; à la fermeture, on
// ré-affiche le chunk pour appliquer proprement tous les réglages.
// Réglages paginés (3 pages navigables ‹ ›), titre + OK toujours visibles.
let reglagesPage = 0;
const REGLAGES_NB_PAGES = 3;
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
$("btn-reglages").addEventListener("click", () => {
  pause();
  ecranLecture.classList.add("apercu");
  montrerReglagesPage(0);
  $("panneau-reglages").classList.remove("cache");
  afficherChunk();
});
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

$("reglage-modele")?.addEventListener("change", (e) => {
  activerModele(e.target.value);
  // Chaque modèle re-découpe le texte à sa façon (en conservant la position)
  if (etat.chapitresTexte) {
    if (etat.mots && etat.mots.length) etat.progression = etat.index / etat.mots.length;
    retokeniser();
    remplirSelectChapitres();
    placerMarqueursChapitres();
  }
  etat.elan = 1;
  afficherChunk();
});
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
  etat.dialoguesEffets = (val || "").split(",").map((s) => s.trim()).filter((s) => s && s !== "aucun");
  $("reglage-dialogues").value = val || "aucun";
  try { localStorage.setItem("bookreeder-dialogues", val || "aucun"); } catch (e) {}
  // Le multicolore a besoin de la carte des locuteurs (calculée au chargement).
  if (effetDialogue("multicolore") && !etat.couleurParMot && etat.mots.length) calculerLocuteurs();
  if (!ecranLecture.classList.contains("cache")) afficherChunk();
}
$("reglage-dialogues").addEventListener("change", (e) => appliquerDialogues(e.target.value));
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
// Afficher les infos de lecture (position · chapitre · mots) en Mode Loupe
$("reglage-infos-loupe").addEventListener("change", (e) => {
  etat.infosLoupe = e.target.checked;
  $("ecran-contexte").classList.toggle("infos-loupe", e.target.checked);
  try { localStorage.setItem("bookreeder-infos-loupe", e.target.checked ? "1" : "0"); } catch (err) {}
});
(function initInfosLoupe() {
  let on = false;
  try { on = localStorage.getItem("bookreeder-infos-loupe") === "1"; } catch (e) {}
  $("reglage-infos-loupe").checked = on;
  etat.infosLoupe = on;
  $("ecran-contexte").classList.toggle("infos-loupe", on);
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
function appliquerCoefPause(v) {
  etat.coefPause = v;
  $("reglage-pauses").value = v;
  $("valeur-pauses").textContent = v.toFixed(1).replace(".", ",");
  try { localStorage.setItem("bookreeder-coef-pause", v); } catch (e) {}
}
$("reglage-pauses").addEventListener("input", (e) => appliquerCoefPause(+e.target.value));
(function initCoefPause() {
  let v = 2;
  try { const s = localStorage.getItem("bookreeder-coef-pause"); if (s) v = +s; } catch (e) {}
  appliquerCoefPause(v);
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

// Boutons de la barre épurée : clic = navigation phrase ; appui long (≈0,5 s) =
// déplace le groupe de boutons vers ce côté (utile en paysage, à une main).
function installerFlecheEpure(id, action, cote) {
  const btn = $(id);
  if (!btn) return;
  let timer = null, long = false;
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(() => {
      long = true;
      ecranLecture.classList.remove("nav-gauche", "nav-droite");
      ecranLecture.classList.add(cote);
    }, 500);
  });
  ["pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
  btn.addEventListener("pointerup", () => clearTimeout(timer));
  btn.addEventListener("click", () => {
    if (long) { long = false; return; }   // c'était un appui long → pas de navigation
    action();
  });
}
installerFlecheEpure("ep-recul", () => deplacer(phrasePrecedente() - etat.index, true), "nav-gauche");
installerFlecheEpure("ep-avance", () => deplacer(phraseSuivante() - etat.index, true), "nav-droite");
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
}
mqPaysage.addEventListener("change", gererOrientation);
gererOrientation();

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
    verifier();                                   // vérifie au démarrage
    // …et à chaque fois qu'on revient sur l'onglet / rouvre l'app
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) verifier();
    });
  }).catch(() => {});
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
