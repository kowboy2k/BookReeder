"use strict";

// --- État global ---
const etat = {
  mots: [],          // liste des mots du livre
  index: 0,          // position de lecture actuelle
  enLecture: false,
  minuteur: null,
  vitesse: 300,      // mots/min
  nbMots: 1,         // mots affichés simultanément
  orpActif: true,
};

// --- Références DOM ---
const $ = (id) => document.getElementById(id);
const ecranAccueil = $("ecran-accueil");
const ecranLecture = $("ecran-lecture");
const motAffiche = $("mot-affiche");
const zoneMot = $("zone-mot");

// =========================================================
//  Chargement du fichier EPUB
// =========================================================
$("input-fichier").addEventListener("change", async (e) => {
  const fichier = e.target.files[0];
  if (!fichier) return;
  const msg = $("message-chargement");
  msg.textContent = "Lecture du fichier…";
  try {
    const buffer = await fichier.arrayBuffer();
    const livre = ePub(buffer);
    await livre.ready;
    const texte = await extraireTexte(livre);
    etat.mots = decouperEnMots(texte);
    if (etat.mots.length === 0) throw new Error("Aucun texte trouvé");
    etat.index = 0;
    demarrerLecture();
  } catch (err) {
    console.error(err);
    msg.textContent = "Impossible de lire ce fichier : " + err.message;
  }
});

// Parcourt tous les chapitres et concatène le texte brut
async function extraireTexte(livre) {
  const morceaux = [];
  const sections = livre.spine.spineItems;
  for (const section of sections) {
    const doc = await section.load(livre.load.bind(livre));
    morceaux.push(doc.body ? doc.body.textContent : "");
    section.unload();
  }
  return morceaux.join("\n\n");
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

  const avant = motAffiche.querySelector(".avant");
  const orp = motAffiche.querySelector(".orp");
  const apres = motAffiche.querySelector(".apres");

  if (idxOrp < 0) {
    avant.textContent = "";
    orp.textContent = chunk;
    apres.textContent = "";
    // Centre simplement tout le chunk
    motAffiche.style.setProperty("--decalage-orp",
      (motAffiche.getBoundingClientRect().width / 2) + "px");
  } else {
    avant.textContent = chunk.slice(0, idxOrp);
    orp.textContent = chunk[idxOrp];
    apres.textContent = chunk.slice(idxOrp + 1);
    // Décalage = bord gauche du mot → centre de la lettre ORP
    const decalage = avant.getBoundingClientRect().width
                   + orp.getBoundingClientRect().width / 2;
    motAffiche.style.setProperty("--decalage-orp", decalage + "px");
  }
  majProgression();
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
  const pct = (etat.index / etat.mots.length) * 100;
  $("progression-remplissage").style.width = pct + "%";
  $("position-actuelle").textContent = etat.index;
  $("total-mots").textContent = etat.mots.length;
}

function demarrerLecture() {
  ecranAccueil.classList.add("cache");
  ecranLecture.classList.remove("cache");
  appliquerOrp();
  afficherChunk();
}

// =========================================================
//  Contrôles UI
// =========================================================
$("btn-lecture").addEventListener("click", basculerLecture);
$("btn-recul").addEventListener("click", () => deplacer(-etat.nbMots * 5));
$("btn-avance").addEventListener("click", () => deplacer(etat.nbMots * 5));
$("btn-fermer").addEventListener("click", () => {
  pause();
  ecranLecture.classList.add("cache");
  ecranAccueil.classList.remove("cache");
  $("input-fichier").value = "";
  $("message-chargement").textContent = "";
});

// Réglages
$("btn-reglages").addEventListener("click", () => $("panneau-reglages").classList.remove("cache"));
$("btn-fermer-reglages").addEventListener("click", () => $("panneau-reglages").classList.add("cache"));

$("reglage-vitesse").addEventListener("input", (e) => {
  etat.vitesse = +e.target.value;
  $("valeur-vitesse").textContent = etat.vitesse;
});
$("reglage-nb-mots").addEventListener("input", (e) => {
  etat.nbMots = +e.target.value;
  $("valeur-nb-mots").textContent = etat.nbMots;
  afficherChunk();
});
$("reglage-orp").addEventListener("change", (e) => {
  etat.orpActif = e.target.checked;
  appliquerOrp();
  afficherChunk();
});

function appliquerOrp() {
  zoneMot.classList.toggle("sans-orp", !etat.orpActif);
  motAffiche.classList.toggle("sans-orp", !etat.orpActif);
}

// Raccourcis clavier (PC/Mac)
document.addEventListener("keydown", (e) => {
  if (ecranLecture.classList.contains("cache")) return;
  if (e.code === "Space") { e.preventDefault(); basculerLecture(); }
  else if (e.code === "ArrowLeft") deplacer(-etat.nbMots * 5);
  else if (e.code === "ArrowRight") deplacer(etat.nbMots * 5);
});

// Toucher l'écran central = lecture/pause (mobile / Vivlio)
zoneMot.addEventListener("click", basculerLecture);

// PWA : enregistrement du service worker pour le hors-ligne
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
