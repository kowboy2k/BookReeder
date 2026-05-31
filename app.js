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
  vitesse: 300,      // mots/min
  nbMots: 1,         // mots affichés simultanément (max souhaité)
  nbCourant: 1,      // mots réellement affichés dans le chunk courant
  continuerApresSaut: true, // garder la lecture en marche après avance/retour
  pauseFinChapitre: true,   // se mettre en pause à la fin de chaque chapitre
  coefPause: 1,      // coefficient multiplicateur des temps de pause (0,5–4)
  elan: 1,           // « momentum » : <1 juste après une pause, remonte vers 1
  orpActif: true,
  bionic: false,     // lecture bionic (début des mots en gras)
  modeleId: "default", // modèle de lecture actif (groupement + rythme + ORP + bionic)
  modele: null,        // objet modèle courant (défini au démarrage)
};

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
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// =========================================================
//  Bibliothèque persistante (IndexedDB)
//  On stocke le texte déjà découpé + les chapitres pour
//  reprendre instantanément sans relire l'EPUB.
// =========================================================
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
  const buffer = await fichier.arrayBuffer();
  await chargerEpub(buffer, fichier.name, fichier.size);
});

// Charge un EPUB (ArrayBuffer), extrait le texte + les chapitres,
// l'enregistre dans la bibliothèque et démarre la lecture
async function chargerEpub(buffer, nom, taille) {
  const msg = $("message-chargement");
  msg.textContent = "Lecture du fichier…";
  try {
    const livre = ePub(buffer);
    await livre.ready;
    const { chapitresTexte } = await extraireLivre(livre);
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
      chapitresTexte, progression: 0, total: apercu.mots.length,
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

$("btn-demo").addEventListener("click", () => {
  etat.chapitresTexte = [{ titre: "Texte de démo", texte: TEXTE_DEMO }];
  etat.idLivre = null;
  etat.nomLivre = "Démo";
  etat.titreLivre = "Texte de démo";
  etat.progression = 0;
  retokeniser();
  remplirSelectChapitres();
  placerMarqueursChapitres();
  demarrerLecture();
});

// Extrait le livre sous forme de TEXTE BRUT par chapitre : [{ titre, texte }].
// La tokenisation en mots (et donc les index de chapitre) est faite ENSUITE
// par le modèle actif (tokeniserChapitres), pour que chaque modèle puisse
// découper le texte à sa façon. Les chapitres viennent de la TOC (ancres
// incluses) ; sinon une entrée par section.
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
      const fullText = corps ? texteAvecSeparateurs(corps).trim()
                             : (contenu ? (contenu.textContent || "").trim() : "");
      if (!fullText) continue;
      const baseHref = (section.href || "").split("#")[0];
      nSection++;

      // Entrées TOC de cette section
      const entriesIci = toc.filter((t) => t.href.split("#")[0] === baseHref);
      const sansAncre = entriesIci.find((t) => !t.href.includes("#"));
      const labelSection = (sansAncre && sansAncre.label) ||
        (entriesIci[0] && !entriesIci[0].href.includes("#") ? entriesIci[0].label : "") ||
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
        chapitresTexte.push({ titre: labelSection, texte: fullText });
      } else {
        // Texte avant la 1re ancre -> rattaché au chapitre précédent, ou "Début"
        const avant = texteEntre(doc, corps, null, ancres[0].el);
        if (avant) {
          if (chapitresTexte.length) chapitresTexte[chapitresTexte.length - 1].texte += "\n" + avant;
          else chapitresTexte.push({ titre: labelSection || "Début", texte: avant });
        }
        ancres.forEach((a, i) => {
          const t = texteEntre(doc, corps, a.el, ancres[i + 1] ? ancres[i + 1].el : null);
          if (t) chapitresTexte.push({ titre: a.label || ("Chapitre " + chapitresTexte.length), texte: t });
        });
      }
    } catch (e) {
      console.warn("Section illisible ignorée", e);
    } finally {
      section.unload();
    }
  }

  if (chapitresTexte.length === 0) chapitresTexte.push({ titre: "Début", texte: "" });
  return { chapitresTexte };
}

// Tokenise le texte par chapitre avec le découpage `decouper` du modèle actif,
// et calcule les index de début de chaque chapitre.
function tokeniserChapitres(chapitresTexte, decouper) {
  const mots = [];
  const chapitres = [];
  (chapitresTexte || []).forEach((ch) => {
    const m = decouper(ch.texte || "");
    if (m.length === 0) return;
    chapitres.push({ titre: ch.titre || "Chapitre", debut: mots.length });
    mots.push(...m);
  });
  if (chapitres.length === 0) chapitres.push({ titre: "Début", debut: 0 });
  return { mots, chapitres };
}

// (Re)tokenise le livre courant avec le modèle actif, en conservant la
// position relative (progression) de lecture.
function retokeniser() {
  const { mots, chapitres } = tokeniserChapitres(etat.chapitresTexte, etat.modele.decouper);
  etat.mots = mots;
  etat.chapitres = chapitres;
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
function texteAvecSeparateurs(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("br").forEach((b) => b.replaceWith(" "));
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

  const mots = [];
  let enAttente = "";   // ponctuation ouvrante à coller au prochain mot
  for (const brut of bruts) {
    if (!estMot(brut)) {                 // jeton sans lettre ni chiffre
      if (ouvrante.test(brut) || mots.length === 0) {
        enAttente = enAttente ? enAttente + " " + brut : brut;  // → mot suivant
      } else {
        mots[mots.length - 1] += " " + brut;                    // → mot précédent
      }
      continue;
    }
    const mot = enAttente ? enAttente + " " + brut : brut;
    enAttente = "";
    mots.push(mot);
  }
  // Reliquat (texte finissant par de la ponctuation) : on le colle au dernier mot.
  if (enAttente) {
    if (mots.length > 0) mots[mots.length - 1] += " " + enAttente;
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
  // Nom propre : titre + nom, ou 2 mots (ou plus) à majuscule consécutifs
  const m0 = etat.mots[start];
  if (estMotMajuscule(m0) && (estHonorifique(m0) || estMotMajuscule(etat.mots[start + 1]))) {
    const parts = [];
    for (let i = start; i < etat.mots.length; i++) {
      const mot = etat.mots[i];
      parts.push(mot);
      if (estHonorifique(mot)) continue;              // un titre ne coupe jamais
      if (PONCT_COUPE.test(mot)) break;               // ponctuation finale -> fin du nom
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
    // Un mot long démarre un nouveau groupe ; et un groupe ne dépasse jamais
    // `lettresMax` lettres (au-delà, on réduit à moins de mots / 1 mot).
    if (parts.length > 0 && (longMot || lettres + lg > lettresMax)) break;
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

function delaiChunk() {
  const P = etat.modele.params;                 // recette de rythme du modèle actif
  const base = 60000 / etat.vitesse;            // ms pour un mot « moyen »
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
  if (enDialogue) mot = Math.max(mot, base * P.plancherDialogue);

  let majuscule = false;
  for (let k = 0; k < groupe.length; k++) {
    if (!estDebutPhrase(debut + k) && commenceMajuscule(groupe[k])) { majuscule = true; break; }
  }
  if (majuscule) mot = Math.max(mot, base * P.plancherMajuscule);

  // 3) Respirations ajoutées : ponctuation de fin de groupe + ouverture de réplique
  const dernier = groupe[groupe.length - 1] || "";
  let pause = 0;
  if (/[.!?…]["»”'’)\]]*$/.test(dernier)) pause += base * P.pauseFinPhrase;  // fin de phrase
  else if (/[,;:]["»”'’)\]]*$/.test(dernier)) pause += base * P.pauseVirgule; // virgule, etc.
  const suivant = etat.mots[fin];
  if (suivant && DEBUT_REPLIQUE.test(suivant)) pause += base * P.pauseReplique; // entre échanges

  // 4) Mise à jour de l'élan pour le PROCHAIN groupe : après une vraie pause on
  //    repart doucement, sinon on accélère par paliers (pas d'à-coup).
  if (pause >= base * P.pauseFinPhrase) etat.elan = P.elanGrossePause;  // grosse pause
  else if (pause > 0 || majuscule) etat.elan = P.elanPauseMoyenne;      // pause moyenne
  else etat.elan = Math.min(1, etat.elan + P.elanAccel);                // accélération

  // Le temps de pause est modulé par le coefficient réglable (0,5–4).
  // Plancher absolu : aucun mot ne s'affiche moins de ~Nms (anti-télescopage).
  return Math.max(mot + pause * etat.coefPause, P.affichageMin);
}

// Le mot commence-t-il par une lettre MAJUSCULE (en ignorant tiret/guillemet) ?
function commenceMajuscule(mot) {
  const m = (mot || "").match(/\p{L}/u);
  return !!m && /\p{Lu}/u.test(m[0]);
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
  const base = 60000 / etat.vitesse;
  const texte = etat.mots.slice(etat.index, etat.index + etat.nbCourant).join(" ");
  let delai = base * etat.nbCourant;
  // Pause fixe dès qu'il y a un chiffre ou de la ponctuation (× coef réglable)
  if (/[\d.,!?;:'"`«»…]/.test(texte)) delai += base * P.pauseFactor * etat.coefPause;
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
    nom: "BookReeder (default)",
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
      pauseReplique: 3,        // pause avant une réplique de dialogue (× base)
      plancherDialogue: 1.6,   // durée mini d'un mot en dialogue (× base)
      plancherMajuscule: 3,    // durée mini d'un nom propre en milieu de phrase (× base)
      elanGrossePause: 0.45,   // élan après une grosse pause (reprise lente)
      elanPauseMoyenne: 0.7,   // élan après une pause moyenne
      elanAccel: 0.18,         // accélération de l'élan par mot (vers 1)
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
    nom: "Hybride (découpe BookReeder + rythme HotGato)",
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
  etat.index += etat.nbCourant;
  // Pause en fin de chapitre : on a fini ce chapitre et il en reste un autre.
  if (etat.pauseFinChapitre && finChap < etat.mots.length && etat.index >= finChap) {
    etat.index = finChap;                   // prêt à reprendre au chapitre suivant
    etat.minuteur = setTimeout(pause, d);   // afficher le dernier chunk puis pause
    return;
  }
  etat.minuteur = setTimeout(tick, d);
}

function lecture() {
  if (etat.enLecture) return;
  if (etat.index >= etat.mots.length) etat.index = 0;
  etat.enLecture = true;
  etat.elan = 1;            // repart à pleine cadence
  clearTimeout(etat.minuteur); // évite tout minuteur en double
  iconeLecture(true);
  tick();
}

// Bascule l'icône du bouton : true = en lecture (barres pause), false = play (triangle)
function iconeLecture(joue) {
  const b = $("btn-lecture");
  b.classList.toggle("icone-pause", joue);
  b.classList.toggle("icone-play", !joue);
}

function pause() {
  etat.enLecture = false;
  clearTimeout(etat.minuteur);
  iconeLecture(false);
  sauverPosition();
}

function basculerLecture() {
  etat.enLecture ? pause() : lecture();
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
  $("position-pct").textContent = pctChap.toFixed(0).replace(".", ",");
  $("chapitre-actuel").textContent = tronquerTitre(chapitreActuel().titre);

  if (!$("panneau-navigation").classList.contains("cache")) majBarreLivre();
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
  return t.length > 20 ? t.slice(0, 20).trimEnd() + "..." : t;
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
  $("titre-livre").textContent = etat.titreLivre || etat.nomLivre || "";
  reglerVitesse(etat.vitesse);
  ajusterCadre();
  appliquerOrp();
  afficherChunk();
}

// =========================================================
//  Contrôles UI
// =========================================================
$("btn-lecture").addEventListener("click", basculerLecture);

// Vitesse : − et + par paliers de 20 mots/min (bornes 100–800)
function reglerVitesse(v) {
  etat.vitesse = Math.min(800, Math.max(100, v));
  $("vitesse-actuelle").textContent = etat.vitesse;
}
$("btn-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 20));
$("btn-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 20));

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
  sauverPosition();
});

// =========================================================
//  Panneau de navigation (chapitre + position %)
// =========================================================
function ouvrirNavigation() {
  $("nav-chapitre").value = etat.chapitres.indexOf(chapitreActuel());
  $("panneau-navigation").classList.remove("cache");
  majBarreLivre();
}
$("zone-navigation").addEventListener("click", ouvrirNavigation);
$("btn-fermer-navigation").addEventListener("click", () => {
  $("panneau-navigation").classList.add("cache");
  sauverPosition();
});
$("nav-chapitre").addEventListener("change", (e) => {
  const ch = etat.chapitres[+e.target.value];
  if (!ch) return;
  deplacer(ch.debut - etat.index, true);
});

// =========================================================
//  Bibliothèque sur l'écran d'accueil
// =========================================================
async function afficherBibliotheque() {
  const conteneur = $("bibliotheque");
  conteneur.innerHTML = "";
  let livres = [];
  try { livres = (await listerLivres()) || []; } catch (e) { return; }
  livres.sort((a, b) => b.dateAjout - a.dateAjout);
  if (!livres.length) return;

  const titre = document.createElement("h2");
  titre.textContent = "Mes livres";
  titre.className = "titre-biblio";
  conteneur.appendChild(titre);

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

// Réglages : on met en pause et on fait monter la zone de lecture en aperçu (1/3
// haut) pendant que le panneau occupe les 2/3 du bas ; à la fermeture, on
// ré-affiche le chunk pour appliquer proprement tous les réglages.
$("btn-reglages").addEventListener("click", () => {
  pause();
  ecranLecture.classList.add("apercu");
  $("panneau-reglages").classList.remove("cache");
  afficherChunk();
});
$("btn-fermer-reglages").addEventListener("click", () => {
  $("panneau-reglages").classList.add("cache");
  ecranLecture.classList.remove("apercu");
  afficherChunk(); // re-rendu complet avec les réglages finaux
});

$("reglage-modele").addEventListener("change", (e) => {
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
  etat.nbMots = +e.target.value;
  $("valeur-nb-mots").textContent = etat.nbMots;
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
$("reglage-continuer").addEventListener("change", (e) => {
  etat.continuerApresSaut = e.target.checked;
});
$("reglage-pause-chapitre").addEventListener("change", (e) => {
  etat.pauseFinChapitre = e.target.checked;
});

// --- Longueur des pauses (coefficient multiplicateur) ---
function appliquerCoefPause(v) {
  etat.coefPause = v;
  $("reglage-pauses").value = v;
  $("valeur-pauses").textContent = v.toFixed(1).replace(".", ",");
  try { localStorage.setItem("bookreeder-coef-pause", v); } catch (e) {}
}
$("reglage-pauses").addEventListener("input", (e) => appliquerCoefPause(+e.target.value));
(function initCoefPause() {
  let v = 1;
  try { const s = localStorage.getItem("bookreeder-coef-pause"); if (s) v = +s; } catch (e) {}
  appliquerCoefPause(v);
})();
$("reglage-orp").addEventListener("change", (e) => {
  etat.orpActif = e.target.checked;
  majVisibiliteOrpCouleur();
  appliquerOrp();
  afficherChunk();
});
// La couleur du repère ne s'affiche que si « Repère central » est coché
function majVisibiliteOrpCouleur() {
  const actif = etat.orpActif;
  $("bloc-orp-couleur").style.display = actif ? "flex" : "none";
  $("bloc-orp-perso").style.display =
    (actif && $("reglage-orp-couleur").value === "perso") ? "flex" : "none";
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
               { id: "700", nom: "Gras" }, { id: "900", nom: "Noir" }];
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
    graisse = +varr || 400; bionic = false;
  }
  document.documentElement.style.setProperty("--police", police);
  document.documentElement.style.setProperty("--graisse", graisse);
  etat.bionic = bionic;
  // La couleur du début bionic ne s'affiche que si le bionic est choisi
  $("bloc-bionic-couleur").style.display = bionic ? "flex" : "none";
  $("bloc-bionic-perso").style.display =
    (bionic && $("reglage-bionic-couleur").value === "perso") ? "flex" : "none";
}

// (Re)remplit le menu Variante selon la famille choisie ; défaut = Normal
function remplirVariantes(familleId) {
  const sel = $("reglage-variante");
  const vs = variantesDe(familleId);
  sel.innerHTML = "";
  vs.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.id; o.textContent = v.nom; sel.appendChild(o);
  });
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

// --- Couleur du repère central (lettre ORP) ---
function appliquerOrpCouleur() {
  const choix = $("reglage-orp-couleur").value;
  let couleur;
  if (choix === "aucune") couleur = "currentColor";     // même couleur que le texte
  else if (choix === "perso") couleur = $("reglage-orp-teinte").value;
  else couleur = choix;                                 // préréglage (rouge/vert/jaune)
  document.documentElement.style.setProperty("--orp-couleur", couleur);
  $("bloc-orp-perso").style.display =
    (etat.orpActif && choix === "perso") ? "flex" : "none";
  try {
    localStorage.setItem("bookreeder-orp-couleur", choix);
    localStorage.setItem("bookreeder-orp-teinte", $("reglage-orp-teinte").value);
  } catch (e) {}
}
$("reglage-orp-couleur").addEventListener("change", appliquerOrpCouleur);
$("reglage-orp-teinte").addEventListener("input", appliquerOrpCouleur);
function initialiserOrpCouleur() {
  try {
    const c = localStorage.getItem("bookreeder-orp-couleur");
    const t = localStorage.getItem("bookreeder-orp-teinte");
    if (t) $("reglage-orp-teinte").value = t;
    if (c) $("reglage-orp-couleur").value = c;
  } catch (e) {}
  appliquerOrpCouleur();
  majVisibiliteOrpCouleur();
}
initialiserOrpCouleur();

$("reglage-majuscules").addEventListener("change", (e) => {
  motAffiche.classList.toggle("majuscules", e.target.checked);
  afficherChunk(); // recalcule le centrage ORP (largeurs modifiées)
});
$("reglage-taille-police").addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--echelle-police", e.target.value / 100);
  $("valeur-taille-police").textContent = e.target.value;
  afficherChunk(); // recalcule l'ajustement au cadre + centrage ORP
});
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

// Toucher l'écran central = lecture/pause (mobile / Vivlio)
zoneMot.addEventListener("click", basculerLecture);

// PWA : enregistrement du service worker pour le hors-ligne
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
