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
  nbMots: 1,         // mots affichés simultanément
  pasNav: 10,        // mots sautés par avance/retour rapide
  orpActif: true,
  bionic: false,     // lecture bionic (début des mots en gras)
};

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
// chaque chapitre (index du mot). Les titres viennent de la table des
// matières (TOC) quand elle existe, sinon du nom de section. En dernier
// recours, on pose des repères « Passage N » tous les 1500 mots.
// section.load() peut renvoyer un Document OU l'élément <html> selon
// la version d'epub.js : on gère les deux cas.
async function extraireLivre(livre) {
  // Titres de la TOC indexés par href de section (sans ancre)
  const titres = {};
  try {
    const nav = await livre.loaded.navigation;
    const parcourir = (liste) => liste.forEach((item) => {
      const href = (item.href || "").split("#")[0];
      if (href && !titres[href]) titres[href] = item.label.trim();
      if (item.subitems) parcourir(item.subitems);
    });
    if (nav && nav.toc) parcourir(nav.toc);
  } catch (e) { /* pas de TOC : on continuera sans */ }

  const motsTotal = [];
  const chapitres = [];
  for (const section of livre.spine.spineItems) {
    try {
      const contenu = await section.load(livre.load.bind(livre));
      let corps = null;
      if (contenu) {
        if (contenu.body) corps = contenu.body;                                   // Document
        else if (contenu.querySelector) corps = contenu.querySelector("body") || contenu; // <html>
      }
      const txt = corps ? texteAvecSeparateurs(corps)
                        : (contenu ? contenu.textContent : "");
      const motsSection = txt && txt.trim() ? decouperEnMots(txt.trim()) : [];
      if (motsSection.length) {
        const href = (section.href || "").split("#")[0];
        const titre = titres[href] || ("Section " + (chapitres.length + 1));
        chapitres.push({ titre, debut: motsTotal.length });
        motsTotal.push(...motsSection);
      }
    } catch (e) {
      console.warn("Section illisible ignorée", e);
    } finally {
      section.unload();
    }
  }

  // Aucun chapitre exploitable : repères réguliers tous les 1500 mots
  if (chapitres.length <= 1 && motsTotal.length > 1500) {
    chapitres.length = 0;
    for (let d = 0, n = 1; d < motsTotal.length; d += 1500, n++)
      chapitres.push({ titre: "Passage " + n, debut: d });
  }
  if (chapitres.length === 0) chapitres.push({ titre: "Début", debut: 0 });

  return { mots: motsTotal, chapitres };
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

  // Ponctuation qui ne doit jamais s'afficher seule.
  const ouvrante = /^[«"“'(\[]+$/;          // se rattache au mot SUIVANT
  const fermante = /^[»"”')\].,;:!?…]+$/;   // se rattache au mot PRÉCÉDENT

  const mots = [];
  let enAttente = "";   // ponctuation ouvrante à coller au prochain mot
  for (const brut of bruts) {
    if (ouvrante.test(brut)) {
      enAttente = enAttente ? enAttente + " " + brut : brut;
      continue;
    }
    if (fermante.test(brut) && mots.length > 0) {
      mots[mots.length - 1] += " " + brut;
      continue;
    }
    const mot = enAttente ? enAttente + " " + brut : brut;
    enAttente = "";
    mots.push(mot);
  }
  if (enAttente && mots.length > 0) mots[mots.length - 1] += " " + enAttente;
  return mots;
}

// =========================================================
//  Affichage RSVP avec point ORP
// =========================================================
function afficherChunk() {
  const chunk = etat.mots.slice(etat.index, etat.index + etat.nbMots).join(" ");
  if (!chunk) return;

  const idxOrp = etat.orpActif ? calculerOrp(chunk) : -1;
  motAffiche.innerHTML = construireHtml(chunk, idxOrp);

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
    const grasJusqu = etat.bionic ? Math.max(1, Math.ceil(mot.length * 0.4)) : 0;
    for (let j = 0; j < mot.length; j++, i++) {
      let c = echappe(mot[j]);
      // ORP en interne pour que sa couleur rouge reste prioritaire,
      // bionic en externe pour la graisse + couleur du début de mot
      if (i === idxOrp) c = '<span class="orp">' + c + "</span>";
      if (j < grasJusqu) c = '<span class="bio">' + c + "</span>";
      html += c;
    }
  });
  return html;
}

// Position de la lettre pivot selon la longueur (heuristique Spritz)
function calculerOrp(mot) {
  let i = Math.floor(mot.length / 2) - 1;
  if (i < 0) i = 0;
  // Évite de tomber sur une espace
  if (mot[i] === " ") i = Math.max(0, i - 1);
  return i;
}

// =========================================================
//  Lecture (avance automatique)
// =========================================================
function delaiChunk() {
  const base = 60000 / etat.vitesse;          // ms par mot
  let delai = base * etat.nbMots;
  // Pause supplémentaire en fin de phrase
  const chunk = etat.mots[etat.index + etat.nbMots - 1] || "";
  if (/[.!?…]$/.test(chunk)) delai += base * 2;
  else if (/[,;:]$/.test(chunk)) delai += base;
  return delai;
}

function tick() {
  if (etat.index >= etat.mots.length) {
    pause();
    return;
  }
  afficherChunk();
  const d = delaiChunk();
  etat.index += etat.nbMots;
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
function deplacer(pas) {
  pause();
  etat.index = Math.min(Math.max(0, etat.index + pas), etat.mots.length - 1);
  afficherChunk();
}

function majProgression() {
  const pct = etat.mots.length ? (etat.index / etat.mots.length) * 100 : 0;
  $("progression-remplissage").style.width = pct + "%";
  $("curseur").style.left = pct + "%";
  $("position-actuelle").textContent = etat.index;
  $("total-mots").textContent = etat.mots.length;
  $("position-pct").textContent = pct.toFixed(2).replace(".", ",");
  $("chapitre-actuel").textContent = chapitreActuel().titre;
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

// Place un petit trait sur la barre à chaque début de chapitre
function placerMarqueursChapitres() {
  const conteneur = $("marqueurs-chapitres");
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
  $("valeur-vitesse").textContent = etat.vitesse;
  $("reglage-vitesse").value = etat.vitesse;
}
$("btn-moins").addEventListener("click", () => reglerVitesse(etat.vitesse - 50));
$("btn-plus").addEventListener("click", () => reglerVitesse(etat.vitesse + 50));

// Avance / retour rapide (pas réglable, 5–50 mots)
$("btn-recul").addEventListener("click", () => deplacer(-etat.pasNav));
$("btn-avance").addEventListener("click", () => deplacer(etat.pasNav));

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
const barre = $("barre-progression");
function positionDepuisEvenement(e) {
  const r = barre.getBoundingClientRect();
  let ratio = (e.clientX - r.left) / r.width;
  ratio = Math.min(1, Math.max(0, ratio));
  return Math.round(ratio * (etat.mots.length - 1));
}
let glisse = false;
barre.addEventListener("pointerdown", (e) => {
  if (!etat.mots.length) return;
  glisse = true;
  pause();
  barre.setPointerCapture(e.pointerId);
  etat.index = positionDepuisEvenement(e);
  afficherChunk();
});
barre.addEventListener("pointermove", (e) => {
  if (!glisse) return;
  etat.index = positionDepuisEvenement(e);
  afficherChunk();
});
barre.addEventListener("pointerup", (e) => {
  if (!glisse) return;
  glisse = false;
  barre.releasePointerCapture(e.pointerId);
  sauverPosition();
});

// =========================================================
//  Panneau de navigation (chapitre + position %)
// =========================================================
function ouvrirNavigation() {
  $("nav-chapitre").value = etat.chapitres.indexOf(chapitreActuel());
  $("panneau-navigation").classList.remove("cache");
}
$("info-progression").addEventListener("click", ouvrirNavigation);
$("btn-liste").addEventListener("click", ouvrirNavigation);
$("btn-fermer-navigation").addEventListener("click", () => {
  $("panneau-navigation").classList.add("cache");
  sauverPosition();
});
$("nav-chapitre").addEventListener("change", (e) => {
  const ch = etat.chapitres[+e.target.value];
  if (!ch) return;
  deplacer(ch.debut - etat.index);
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

// Réglages
$("btn-reglages").addEventListener("click", () => $("panneau-reglages").classList.remove("cache"));
$("btn-fermer-reglages").addEventListener("click", () => $("panneau-reglages").classList.add("cache"));

$("reglage-vitesse").addEventListener("input", (e) => reglerVitesse(+e.target.value));
$("reglage-nb-mots").addEventListener("input", (e) => {
  etat.nbMots = +e.target.value;
  $("valeur-nb-mots").textContent = etat.nbMots;
  afficherChunk();
});
$("reglage-pas-nav").addEventListener("input", (e) => {
  etat.pasNav = +e.target.value;
  $("valeur-pas-nav").textContent = etat.pasNav;
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
  else if (e.code === "ArrowLeft") deplacer(-etat.pasNav);
  else if (e.code === "ArrowRight") deplacer(etat.pasNav);
});

// Toucher l'écran central = lecture/pause (mobile / Vivlio)
zoneMot.addEventListener("click", basculerLecture);

// PWA : enregistrement du service worker pour le hors-ligne
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
