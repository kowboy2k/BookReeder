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
  if (livre) { livre.index = etat.index; await sauverLivre(livre); }
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
    const { mots, chapitres } = await extraireLivre(livre);
    if (mots.length === 0) throw new Error("Aucun texte trouvé");

    let titre = nom.replace(/\.epub$/i, "");
    try {
      const meta = await livre.loaded.metadata;
      if (meta && meta.title) titre = meta.title.trim();
    } catch (e) { /* pas de métadonnées : on garde le nom de fichier */ }

    const id = nom + "|" + taille;
    const fiche = {
      id, nom, titre, dateAjout: Date.now(),
      mots, chapitres, index: 0, total: mots.length,
    };
    await sauverLivre(fiche);
    ouvrirFiche(fiche);
  } catch (err) {
    console.error(err);
    msg.textContent = "Impossible de lire ce fichier : " + err.message;
  }
}

// Charge en mémoire une fiche de la bibliothèque et démarre la lecture
function ouvrirFiche(fiche) {
  etat.mots = fiche.mots;
  etat.chapitres = fiche.chapitres && fiche.chapitres.length
    ? fiche.chapitres : [{ titre: "Début", debut: 0 }];
  etat.idLivre = fiche.id;
  etat.nomLivre = fiche.nom;
  etat.titreLivre = fiche.titre || fiche.nom;
  etat.index = Math.min(fiche.index || 0, fiche.mots.length - 1);
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
  etat.mots = decouperEnMots(TEXTE_DEMO);
  etat.chapitres = [{ titre: "Texte de démo", debut: 0 }];
  etat.idLivre = null;
  etat.nomLivre = "Démo";
  etat.titreLivre = "Texte de démo";
  etat.index = 0;
  remplirSelectChapitres();
  placerMarqueursChapitres();
  demarrerLecture();
});

// Parcourt toutes les sections, concatène le texte ET repère où commence
// chaque chapitre (index du mot). La table des matières (TOC) est la
// source principale : chaque entrée pointe vers une section et parfois vers
// une ancre précise (#id) à l'intérieur — on calcule alors le nombre de mots
// avant cette ancre pour situer le chapitre au bon endroit. Sans TOC
// exploitable : repli sur les sections, puis sur des « Passage N » de 1500 mots.
async function extraireLivre(livre) {
  // TOC à plat, en gardant l'ordre et l'ancre éventuelle (#id)
  const toc = [];
  try {
    const nav = await livre.loaded.navigation;
    const parcourir = (liste) => liste.forEach((item) => {
      if (item.href) toc.push({ href: item.href, label: (item.label || "").trim() });
      if (item.subitems && item.subitems.length) parcourir(item.subitems);
    });
    if (nav && nav.toc) parcourir(nav.toc);
  } catch (e) { /* pas de TOC : on continuera sans */ }

  const motsTotal = [];
  const debutSection = {};   // href (sans ancre) -> index du 1er mot
  const debutAncre = {};     // href complet (#id)   -> index du mot

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
      const baseHref = (section.href || "").split("#")[0];
      const txt = corps ? texteAvecSeparateurs(corps)
                        : (contenu ? contenu.textContent : "");
      const motsSection = txt && txt.trim() ? decouperEnMots(txt.trim()) : [];
      const base = motsTotal.length;

      if (motsSection.length) {
        if (debutSection[baseHref] === undefined) debutSection[baseHref] = base;

        // Pour chaque entrée TOC avec ancre dans cette section, compter les
        // mots situés avant l'ancre pour caler le chapitre dessus.
        if (corps && doc && doc.createRange) {
          toc.forEach((t) => {
            const [h, id] = t.href.split("#");
            if (h !== baseHref || !id || debutAncre[t.href] !== undefined) return;
            let el = null;
            try { el = corps.querySelector("#" + cssEchappe(id)); } catch (e) {}
            if (!el && doc.getElementById) el = doc.getElementById(id);
            if (!el) return;
            try {
              const range = doc.createRange();
              range.setStart(corps, 0);
              range.setEndBefore(el);
              const avant = decouperEnMots(range.toString()).length;
              debutAncre[t.href] = base + Math.min(avant, motsSection.length - 1);
            } catch (e) {}
          });
        }
        motsTotal.push(...motsSection);
      }
    } catch (e) {
      console.warn("Section illisible ignorée", e);
    } finally {
      section.unload();
    }
  }

  // Construction des chapitres depuis la TOC (ordre du livre)
  let chapitres = [];
  toc.forEach((t) => {
    let debut = debutAncre[t.href];
    if (debut === undefined) debut = debutSection[t.href.split("#")[0]];
    if (debut !== undefined)
      chapitres.push({ titre: t.label || ("Chapitre " + (chapitres.length + 1)), debut });
  });
  chapitres.sort((a, b) => a.debut - b.debut);
  chapitres = chapitres.filter((c, i) => i === 0 || c.debut > chapitres[i - 1].debut);

  // Repli : pas de TOC -> une entrée par section
  if (chapitres.length === 0) {
    Object.keys(debutSection)
      .sort((a, b) => debutSection[a] - debutSection[b])
      .forEach((h, i) => chapitres.push({ titre: "Section " + (i + 1), debut: debutSection[h] }));
  }
  // Aucun découpage exploitable : un seul repère. Les boutons « chapitre »
  // basculeront alors sur un saut de 1000 mots (voir allerChapitre).
  if (chapitres.length === 0) chapitres.push({ titre: "Début", debut: 0 });
  // Garantit un repère au tout début (matière avant le 1er chapitre de la TOC)
  if (chapitres[0].debut > 0) chapitres.unshift({ titre: "Début", debut: 0 });

  return { mots: motsTotal, chapitres };
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

// Construit le groupe de mots à afficher à partir de `start`, en respectant :
//  - le maximum demandé (etat.nbMots) ;
//  - un mot très long (> 12 caractères) s'affiche seul ;
//  - on n'enchaîne jamais après une fin de phrase (« fin. Début » évité).
function construireChunkDepuis(start) {
  const parts = [];
  for (let i = start; i < start + etat.nbMots && i < etat.mots.length; i++) {
    const mot = etat.mots[i];
    const longMot = longueurVisible(mot) > 12;
    if (parts.length > 0 && longMot) break;     // un mot long démarre un nouveau groupe
    parts.push(mot);
    if (longMot || FIN_PHRASE.test(mot)) break; // mot long seul, ou fin de phrase
  }
  return { texte: parts.join(" "), nb: parts.length || 1 };
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
// Début de réplique de dialogue : tiret ou guillemet ouvrant en tête de mot.
const DEBUT_REPLIQUE = /^[—–―‒\-«]/;

function delaiChunk() {
  const base = 60000 / etat.vitesse;            // ms pour un mot « moyen »
  const debut = etat.index, fin = etat.index + etat.nbCourant;
  const groupe = etat.mots.slice(debut, fin);

  // 1) Durée proportionnelle à la longueur réelle des mots affichés :
  //    les mots longs s'attardent, les courts défilent vite (rythme naturel).
  const chars = groupe.join(" ").replace(/\s+/g, "").length;
  let delai = base * Math.max(0.6 * etat.nbCourant, chars / 5.5);

  // 2) Respirations selon la ponctuation de fin de groupe
  const dernier = groupe[groupe.length - 1] || "";
  if (/[.!?…]["»”'’)\]]*$/.test(dernier)) delai += base * 2;       // fin de phrase
  else if (/[,;:]["»”'’)\]]*$/.test(dernier)) delai += base;       // virgule, etc.

  // 3) Pause marquée entre les échanges : le prochain groupe ouvre une réplique
  const suivant = etat.mots[fin];
  if (suivant && DEBUT_REPLIQUE.test(suivant)) delai += base * 3;

  // 4) Ralentissement pour les mots à majuscule EN MILIEU de phrase (noms
  //    propres, etc.) : le cerveau a besoin d'un temps d'imprégnation. On
  //    exclut les débuts de phrase (déjà capitalisés et déjà précédés d'une pause).
  let bonusMaj = 0;
  for (let k = 0; k < groupe.length; k++) {
    if (!estDebutPhrase(debut + k) && commenceMajuscule(groupe[k])) bonusMaj += base * 0.9;
  }
  delai += Math.min(bonusMaj, base * 2);

  return delai;
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
const MODELES = {
  default: {
    id: "default",
    nom: "BookReeder (default)",
    chunk: construireChunkDepuis,
    delai: delaiChunk,
    orp: calculerOrp,
    gras: bornesGras,
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
  if (etat.index >= etat.mots.length) {
    pause();
    return;
  }
  afficherChunk();           // calcule etat.nbCourant
  const d = etat.modele.delai();
  etat.index += etat.nbCourant;
  etat.minuteur = setTimeout(tick, d);
}

function lecture() {
  if (etat.enLecture) return;
  if (etat.index >= etat.mots.length) etat.index = 0;
  etat.enLecture = true;
  $("btn-lecture").textContent = "⏸";
  tick();
}

function pause() {
  etat.enLecture = false;
  clearTimeout(etat.minuteur);
  $("btn-lecture").textContent = "▶";
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
  etat.index = Math.min(Math.max(0, etat.index + pas), etat.mots.length - 1);
  afficherChunk();
  if (reprendre) {
    // Reprise différée (réarmée à chaque saut) pour permettre d'enchaîner
    etat.minuteur = setTimeout(tick, DELAI_REPRISE);
  } else {
    etat.enLecture = false;
    $("btn-lecture").textContent = "▶";
  }
  sauverPosition();
}

// --- Navigation par phrase ---
// Un mot commence une phrase si le mot précédent terminait la précédente.
function estDebutPhrase(i) {
  if (i <= 0) return true;
  return FIN_PHRASE.test(etat.mots[i - 1] || "");
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
  $("position-pct").textContent = pctChap.toFixed(2).replace(".", ",");
  $("chapitre-actuel").textContent = tronquerTitre(chapitreActuel().titre);

  if (!$("panneau-navigation").classList.contains("cache")) majBarreLivre();
}

// Barre du livre entier (panneau de navigation)
function majBarreLivre() {
  const pct = etat.mots.length ? (etat.index / etat.mots.length) * 100 : 0;
  $("remplissage-livre").style.width = pct + "%";
  $("curseur-livre").style.left = pct + "%";
  $("position-pct-livre").textContent = pct.toFixed(2).replace(".", ",");
  // Le menu déroulant suit automatiquement le chapitre courant
  const sel = $("nav-chapitre");
  if (sel.options.length) sel.value = etat.chapitres.indexOf(chapitreActuel());
}

// Tronque un titre de chapitre trop long pour la ligne d'info
function tronquerTitre(t) {
  t = t || "";
  return t.length > 20 ? t.slice(0, 20).trimEnd() + " [...]" : t;
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

// Vitesse : − et + par paliers de 50 mots/min (bornes 200–800)
function reglerVitesse(v) {
  etat.vitesse = Math.min(800, Math.max(200, v));
  $("vitesse-actuelle").textContent = etat.vitesse;
}
$("btn-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 50));
$("btn-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 50));

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
$("btn-liste").addEventListener("click", ouvrirNavigation);
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
    const pct = livre.total ? Math.round(livre.index / livre.total * 100) : 0;
    const item = document.createElement("div");
    item.className = "item-livre";
    item.innerHTML =
      `<div class="item-infos">` +
        `<span class="item-nom"></span>` +
        `<span class="item-meta">Ajouté le ${formatDate(livre.dateAjout)} · ${pct}%</span>` +
      `</div>` +
      `<button class="item-suppr" title="Retirer">×</button>`;
    item.querySelector(".item-nom").textContent = livre.nom;
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

// Réglages
$("btn-reglages").addEventListener("click", () => $("panneau-reglages").classList.remove("cache"));
$("btn-fermer-reglages").addEventListener("click", () => $("panneau-reglages").classList.add("cache"));

$("reglage-modele").addEventListener("change", (e) => {
  activerModele(e.target.value);
  afficherChunk();
});
$("reglage-nb-mots").addEventListener("input", (e) => {
  etat.nbMots = +e.target.value;
  $("valeur-nb-mots").textContent = etat.nbMots;
  ajusterCadre();
  afficherChunk();
});

// Largeur du cartouche calculée automatiquement selon le nombre de mots
// affichés (1 à 4) : plus il y a de mots, plus le cadre est large, pour que
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
$("reglage-orp").addEventListener("change", (e) => {
  etat.orpActif = e.target.checked;
  appliquerOrp();
  afficherChunk();
});
$("reglage-bionic").addEventListener("change", (e) => {
  etat.bionic = e.target.checked;
  afficherChunk();
});

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
$("reglage-police").addEventListener("change", (e) => {
  document.documentElement.style.setProperty("--police", e.target.value);
  afficherChunk();
});
$("reglage-graisse").addEventListener("change", (e) => {
  document.documentElement.style.setProperty("--graisse", e.target.value);
  afficherChunk();
});
$("reglage-majuscules").addEventListener("change", (e) => {
  motAffiche.classList.toggle("majuscules", e.target.checked);
  afficherChunk(); // recalcule le centrage ORP (largeurs modifiées)
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
