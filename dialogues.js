// =========================================================
//  Moteur des dialogues (chargé à la demande)
// =========================================================
// Ce module n'est chargé QUE si une option « Dialogues dynamiques » qui en a
// besoin est active (Multicolore ou Élocution). Il s'appuie sur des globaux
// d'app.js : etat, DEBUT_REPLIQUE, estDebutPhrase, debutPhraseAvant, dansDialogue,
// normTitre, COUL_PRINCIPAL/SEC1/SEC2. Il expose window.MoteurDialogues.
//
// Responsabilités : identifier les dialogues, les personnages (nom + genre via
// « -t-il / -t-elle »), les incises/médianes, colorer par personnage (multicolore),
// et la décélération d'élocution (diction).

(function () {
  "use strict";

  // --- Verbes de parole (incise : « dit Margaret », « Margaret s'écria ») ---
  const VERBES_PAROLE = /^(dit|dis|dirent|r[ée]pond(it|irent)|r[ée]pliqu(a|èrent)|s[' ]?[ée]cri(a|èrent)|demand(a|èrent)|murmur(a|èrent)|souffl(a|èrent)|lan[çc](a|èrent)|ajout(a|èrent)|repr(it|irent)|s[' ]?exclam(a|èrent)|s[' ]?[ée]tonn(a|èrent)|soupir(a|èrent)|cri(a|èrent)|fit|firent|insist(a|èrent)|pours(uivit|uivirent)|chuchot(a|èrent)|gémit|grogn(a|èrent)|interrog(ea|èrent)|questionn(a|èrent)|conclu(t|rent)|affirm(a|èrent)|d[ée]clar(a|èrent)|expliqu(a|èrent)|raill(a|èrent)|ordonn(a|èrent)|protest(a|èrent)|balbut(ia|ièrent)|annon[çc](a|èrent)|rétorqu(a|èrent)|tonn(a|èrent)|conc[ée]d(a|èrent)|avou(a|èrent)|assur(a|èrent)|repri(t|rent)|rappel(a|èrent)|coup(a|èrent)|tranch(a|èrent)|observ(a|èrent)|remarqu(a|èrent)|gliss(a|èrent)|ren[âa]cl(a|èrent)|gront(a|èrent)|s[' ]?enquit|repli(a|èrent)|repart(it|irent)|opin(a|èrent)|acquies[çc](a|èrent)|haus(sa|sèrent)|gloss(a|èrent)|maugr[ée](a|èrent)|persifl(a|èrent)|s[' ]?empress(a|èrent)|rench[ée]r(it|irent)|répét(a|èrent)|interromp(it|irent)|précis(a|èrent)|corrig(ea|èrent)|bredouill(a|èrent)|marmonn(a|èrent)|hurl(a|èrent)|beugl(a|èrent)|glap(it|irent)|s[' ]?esclaff(a|èrent)|plaisant(a|èrent)|ironis(a|èrent)|grond(a|èrent)|siffl(a|èrent)|bafouill(a|èrent)|s[' ]?emport(a|èrent)|lâch(a|èrent)|ricana|ricanèrent|pouff(a|èrent)|glouss(a|èrent))$/i;

  function motNu(m) { return (m || "").replace(/’/g, "'").replace(/[^\p{L}'-]/gu, ""); }

  // Suffixe pronominal d'inversion (« répondit-il », « demanda-t-elle », « dit-on »…).
  const SUFFIXE_PRON = /-(t-)?(il|elle|on|je|tu|nous|vous|ils|elles|le|la|les|moi|toi|lui|leur)$/i;
  // Sujet inversé EUPHONIQUE (« -t-il ») : signal d'incise fiable à 100 %, quel
  // que soit le verbe (même inconnu : « concéda-t-il », « rétorqua-t-elle »).
  const RE_PRON_INV_T = /-t-(il|elle|on|ils|elles)$/i;
  const RE_PRON_M = /-(t-)?(il|ils)$/i;
  const RE_PRON_F = /-(t-)?(elle|elles)$/i;

  // Le mot est-il un verbe de parole, même avec un sujet inversé accolé ?
  function estVerbeParole(mot) {
    let m = (mot || "").replace(/[^\p{L}'’-]/gu, "").replace(/[’]/g, "'");
    if (VERBES_PAROLE.test(m)) return true;
    const radical = m.replace(SUFFIXE_PRON, "");
    return radical !== m && VERBES_PAROLE.test(radical);
  }
  // Genre déduit d'un sujet inversé (« -il » → M, « -elle » → F).
  function genreMot(mot) {
    const m = motNu(mot);
    if (RE_PRON_M.test(m)) return "M";
    if (RE_PRON_F.test(m)) return "F";
    return "";
  }

  // Article INDÉFINI introduisant un NOUVEAU personnage (tiers).
  const ARTICLE_INDEFINI = /^(un|une|des|d')$/i;

  // Mots capitalisés (début de réplique/phrase) qui NE sont PAS des noms de
  // personnage : pronoms, interjections, oui/non, connecteurs, titres seuls.
  // Comparés à la forme normalisée (sans accents/casse).
  const NOMS_INTERDITS = new Set((
    // pronoms / déterminants
    "il elle ils elles on je tu nous vous lui leur eux moi toi ce ceci cela ca celui celle ceux celles " +
    "mon ma mes ton ta tes son sa ses notre nos votre vos leurs cet cette ces le la les un une des " +
    // oui / non / interjections
    "non oui si ouais ouaip nan eh ah oh ho bah ben hein hum hmm mmm mm euh heu beuh pff chut bref " +
    "bonjour bonsoir salut adieu merci pardon bravo helas tant pis " +
    // connecteurs / adverbes
    "et mais ou or car donc puis alors aussi ainsi enfin certes soudain cependant pourtant neanmoins toutefois " +
    "bien mal bon bonne tres trop assez plus moins jamais toujours encore deja parfois souvent peutetre " +
    "vraiment surtout meme presque ne pas plutot ici la-bas dehors dedans " +
    // interrogatifs / relatifs
    "quoi comment pourquoi quand ou que qui quel quelle quels quelles dont lequel laquelle combien " +
    // verbes courants à l'impératif/début de réplique (faux positifs fréquents)
    "viens venez va vas allez allons tiens tenez regarde regardez ecoute ecoutez attends attendez " +
    "arrete arretez vois voyez dis dites sais savez crois croyez tais arrive entre sors monte descends " +
    "laisse laissez prends prenez donne donnez ferme fermez ouvre ouvrez assez " +
    // titres / vocatifs / divers communs (pas des noms propres de perso)
    "monsieur madame mademoiselle messieurs mesdames mesdemoiselles sir milord milady seigneur dieu mon-dieu " +
    "tout toute tous toutes rien quelque quelques chaque " +
    "juif juifs juive juives chretien chretiens anglais anglaise francais francaise " +
    "m mr mme mlle dr st sainte saint"
  ).split(/\s+/).filter(Boolean));
  function normCle(m) { return window.Chargeur ? Chargeur.normTitre(m) : (m || "").toLowerCase(); }
  // Filtre rigoureux des faux positifs : pas trop court, pas de contraction
  // (J'ai, Qu'as-tu, D'accord…), pas de verbe+pronom inversé (Qu'avez-vous,
  // Viens-tu…), et hors liste de mots courants.
  function nomValide(cle) {
    if (!cle || cle.length < 2) return false;
    if (cle.indexOf("'") >= 0) return false;                                  // contraction / élision
    if (/-(vous|tu|il|elle|on|nous|ils|elles|moi|toi|le|la|les|en|y|ce|toi)$/.test(cle)) return false;  // verbe + pronom
    if (NOMS_INTERDITS.has(cle)) return false;
    if (NOMS_INTERDITS.has(cle.replace(/-/g, ""))) return false;              // « peut-être » → « peutetre »
    return true;
  }
  // Titres/civilités à retirer de la tête d'un nom (« lord John Grey » → « John Grey »).
  const TITRES = new Set("lord lady sir milord milady major colonel general capitaine lieutenant sergent comte comtesse duc duchesse baron baronne roi reine prince princesse docteur professeur maitre maitresse dame monsieur madame mademoiselle pere mere oncle tante frere soeur cousin cousine petit petite jeune vieux vieille grand grande".split(" "));
  // Le mot à l'index j est-il un jeton de NOM PROPRE (majuscule initiale, pas un
  // verbe, hors mots interdits) ?
  function estNomToken(j) {
    if (j < 0 || j >= etat.mots.length) return false;
    const n = motNu(etat.mots[j]);
    if (!n || !/\p{Lu}/u.test(n[0] || "")) return false;
    if (estVerbe(etat.mots[j])) return false;
    return nomValide(normCle(n));
  }
  // Capture la séquence CONTIGUË de noms propres autour de `idx` (sens +1 = vers
  // l'avant, -1 = vers l'arrière), sans franchir de frontière de phrase, titres de
  // tête retirés. Renvoie « Prénom Nom » (casse d'origine) ou "".
  function phraseNom(idx, sens) {
    const toks = [];
    let j = idx;
    while (estNomToken(j) && toks.length < 4) {
      if (sens > 0) toks.push(motNu(etat.mots[j])); else toks.unshift(motNu(etat.mots[j]));
      if (sens > 0) { if (j + 1 < etat.mots.length && estDebutPhrase(j + 1)) break; }
      else { if (estDebutPhrase(j)) break; }
      j += sens;
    }
    while (toks.length && TITRES.has(normCle(toks[0]))) toks.shift();
    return toks.join(" ");
  }

  // Cherche le locuteur d'une réplique commençant au mot `deb`.
  // Renvoie { nom, genre, tiers } : nom = identifiant ; genre = "M"/"F"/"" (via
  // pronom inversé) ; tiers = true pour un locuteur descriptif (« un homme »).
  // Verbe de parole en tolérant une élision de tête (« l'assura », « s'écria »)
  // et un pronom inversé en fin (« répondit-il »).
  function radicalVerbe(m) { return motNu(m).replace(/^(l|m|t|s|n|j|qu|d)'/i, ""); }
  function estVerbe(m) { const w = radicalVerbe(m); return VERBES_PAROLE.test(w) || estVerbeParole(w); }
  function aPronom(m) { return /-(t-)?(il|elle|on|ils|elles)$/i.test(motNu(m)); }

  function locuteurDeReplique(deb) {
    const mots = etat.mots;
    let fin = deb + 1; while (fin < mots.length && !estDebutPhrase(fin)) fin++;
    const finForte = /[?!…][”»"')\]]*$/.test((mots[fin - 1] || "").trim());
    const limite = Math.min(fin + 8, mots.length);
    // 1) Genre : 1er verbe de parole à sujet inversé (« répondit-il », « demanda-t-elle »),
    //    qu'il soit DANS la réplique (après virgule) ou juste après.
    let genre = "";
    for (let k = deb; k < limite; k++) {
      if (k > deb && DEBUT_REPLIQUE.test((mots[k] || "").trimStart())) break;   // pas la réplique suivante
      if (estVerbe(mots[k])) { const g = genreMot(mots[k]); if (g) { genre = g; break; } }
    }
    // 2) Nom / tiers : incise « verbe + Nom » ou « Nom + verbe » (le verbe ne doit
    //    pas porter de pronom inversé), ou tiers « verbe + un/une + nom commun ».
    for (let k = deb; k < limite; k++) {
      if (k > deb && DEBUT_REPLIQUE.test((mots[k] || "").trimStart())) break;   // pas la réplique suivante
      const a = mots[k], b = mots[k + 1] || "";
      const na = motNu(a), nb = motNu(b);
      if (estVerbe(a) && !aPronom(a) && estNomToken(k + 1)) { const ph = phraseNom(k + 1, +1); if (ph) return { nom: ph, genre, tiers: false }; }
      if (estNomToken(k) && !estVerbe(a) && estVerbe(b) && !aPronom(b)) { const ph = phraseNom(k, -1); if (ph) return { nom: ph, genre, tiers: false }; }
      if (k === fin) {
        const estV = estVerbe(a) || (finForte && !estVerbe(a) && /^\p{Ll}/u.test(na));
        if (estV && ARTICLE_INDEFINI.test(nb.toLowerCase())) {
          const nc = motNu(mots[k + 2] || "");
          // Genre du tiers déduit de l'article (« un homme » → M, « une femme » → F).
          const art = nb.toLowerCase();
          const gT = art === "un" ? "M" : art === "une" ? "F" : "";
          if (nc) return { nom: (na + " " + nc).toLowerCase(), genre: gT, tiers: true };
        }
      }
      if (k >= fin && estDebutPhrase(k + 1)) break;   // ne déborde pas sur la réplique suivante
    }
    if (genre) return { nom: "", genre, tiers: false };
    return { nom: "", genre: "", tiers: false };
  }

  // Indices de mots appartenant à une INCISE (à NE PAS colorer) au sein d'une réplique.
  function zonesIncise(deb, fin) {
    const set = new Set();
    // Didascalies entre parenthèses (« (Il s'interrompit, toussa.) ») = narration.
    let paren = false;
    for (let i = deb; i < fin; i++) {
      const w = etat.mots[i] || "";
      if (/\(/.test(w)) paren = true;
      if (paren) set.add(i);
      if (/\)/.test(w)) paren = false;
    }
    const finSegment = (i) => {
      const m = (etat.mots[i] || "").trim();
      return /[?!…][”»"')\]]*$/.test(m) || /,$/.test(m.replace(/[”»"')\]]+$/, ""));
    };
    let s = deb;
    while (s < fin) {
      let e = s;
      while (e < fin) {
        if (e > s && estDebutPhrase(e)) { e--; break; }
        if (finSegment(e)) break;
        e++;
      }
      if (e >= fin) e = fin - 1;
      const prem = (etat.mots[s] || "").replace(/^[^\p{L}]+/u, "");
      const motPrec = s > deb ? (etat.mots[s - 1] || "").trim() : "";
      const apresFinForte = /[?!…][”»"')\]]*$/.test(motPrec);
      let incise = false;
      // (a) Détection d'incise UNIQUEMENT sur un segment NON initial (l'ouverture
      //     d'une réplique est toujours du dialogue, jamais une incise) : verbe de
      //     parole OU sujet inversé euphonique « -t-il/-t-elle » dans les 3 premiers
      //     mots (« , concéda-t-il enfin »). Évite le faux positif des questions
      //     parlées (« L'enfant a-t-il un nom ? »).
      if (s > deb) {
        for (let k = s; k <= Math.min(e, s + 2); k++) {
          if (estVerbeParole(etat.mots[k]) || RE_PRON_INV_T.test(motNu(etat.mots[k]))) { incise = true; break; }
        }
      }
      // (b) RÈGLE TYPO : segment non initial démarrant en MINUSCULE juste après
      //     une FIN FORTE (? ! …) → incise (« ricana un homme… »).
      if (!incise && s > deb && apresFinForte && prem && /\p{Ll}/u.test(prem[0])) incise = true;
      if (incise) for (let x = s; x <= e; x++) set.add(x);
      s = e + 1;
    }
    return set;
  }

  // Construit etat.couleurParMot : une couleur STABLE par personnage.
  // On regroupe en conversations (≤ GAP_MAX mots entre répliques). Dans chaque
  // bloc, 2 voix ; on rattache une voix à un nom et/ou à un genre (pronom), ce
  // qui RÉ-ANCRE l'attribution et évite les inversions. Les tiers (« un homme »)
  // prennent la 3ᵉ couleur sans perturber l'alternance.
  function calculerLocuteurs() {
    const mots = etat.mots; const map = new Map();
    if (!mots || !mots.length) { etat.couleurParMot = map; return; }
    // Palette « Aucune » : couleur uniforme → aucune coloration par personnage.
    if (etat.paletteDialogue === "aucune") { etat.couleurParMot = map; etat.baseCouleurPerso = {}; return; }
    const debutBloc = (i) => i <= 0 || (etat.debutsPhrase && etat.debutsPhrase.has(i));

    // Résolution des noms (mot seul → nom complet canonique) construite sur tout le livre.
    const resol = (etat.persos && etat.persos.resolution) || analyserPersonnages().resolution || {};
    const repliques = []; const compte = {};
    for (let i = 0; i < mots.length; i++) {
      if (!(debutBloc(i) && DEBUT_REPLIQUE.test((mots[i] || "").trimStart()))) continue;
      let fin = i + 1; while (fin < mots.length && !debutBloc(fin)) fin++;
      const loc = locuteurDeReplique(i);
      let nom = "";
      if (!loc.tiers && loc.nom) { const ph = loc.nom.split(/\s+/).map(normCle).join(" "); nom = resol[ph] || ph; }
      if (nom) compte[nom] = (compte[nom] || 0) + 1;
      repliques.push({ deb: i, fin, nom, genre: loc.genre || "", tiers: !!loc.tiers });
      i = fin - 1;
    }
    if (!repliques.length) { etat.couleurParMot = map; return; }

    // Genre connu d'un nom (si une de ses répliques portait un pronom).
    const genreNom = {};
    for (const r of repliques) if (r.nom && r.genre && !genreNom[r.nom]) genreNom[r.nom] = r.genre;
    // Couleur de BASE fixe par personnage : on répartit les couleurs de la palette
    // par ordre de fréquence (le plus bavard = 1ʳᵉ couleur, etc.). Une teinte peut
    // se répéter entre personnages éloignés (palette limitée à 3 voix). L'utilisateur
    // peut figer une couleur précise par personnage (etat.couleursPersonnages).
    const PALETTE_VOIX = [COUL_PRINCIPAL, COUL_SEC1, COUL_SEC2];
    const baseCouleur = {};
    Object.keys(compte).sort((a, b) => compte[b] - compte[a])
      .forEach((n, i) => { baseCouleur[n] = PALETTE_VOIX[i % PALETTE_VOIX.length]; });

    const GAP_MAX = 80; let b = 0;
    while (b < repliques.length) {
      let e = b;
      while (e + 1 < repliques.length && repliques[e + 1].deb - repliques[e].fin <= GAP_MAX) e++;

      const voixNom = [null, null];     // nom rattaché à chaque voix
      const voixGenre = [null, null];   // genre rattaché à chaque voix
      let attendu = 0;                  // voix attendue par alternance
      const idx = [];                   // 0/1 = voix, -1 = tiers
      for (let k = b; k <= e; k++) {
        const r = repliques[k];
        if (r.tiers) { idx[k] = -1; continue; }
        let v = -1;
        if (r.nom) { if (voixNom[0] === r.nom) v = 0; else if (voixNom[1] === r.nom) v = 1; }
        if (v < 0 && r.genre) {
          // même genre qu'une voix → cette voix ; sinon, si une voix est du
          // genre OPPOSÉ, c'est forcément l'AUTRE (un homme et une femme ne
          // peuvent pas être la même voix).
          if (voixGenre[0] === r.genre) v = 0;
          else if (voixGenre[1] === r.genre) v = 1;
          else if (voixGenre[0] && voixGenre[0] !== r.genre) v = 1;
          else if (voixGenre[1] && voixGenre[1] !== r.genre) v = 0;
        }
        if (v < 0) v = attendu;
        if (r.nom && !voixNom[v]) voixNom[v] = r.nom;
        const g = r.genre || (r.nom && genreNom[r.nom]) || "";
        if (g && !voixGenre[v]) voixGenre[v] = g;
        idx[k] = v;
        attendu = 1 - v;
      }
      const ov = etat.couleursPersonnages || {};   // couleurs attribuées par l'utilisateur (par livre)
      const couleurPerso = (nom) => ov[nom] || baseCouleur[nom] || COUL_PRINCIPAL;
      for (let k = b; k <= e; k++) {
        const r = repliques[k];
        let c;
        if (r.tiers) {                                   // personnage tiers (« un homme »…)
          c = ov[r.genre === "F" ? "tiers-f" : "tiers-m"] || COUL_SEC2;
        } else {
          // Personnage explicite, sinon déduit de la voix (alternance) du bloc → SA couleur fixe.
          const nom = r.nom || voixNom[idx[k]];
          c = nom ? couleurPerso(nom) : (idx[k] === 0 ? COUL_PRINCIPAL : COUL_SEC1);
        }
        const inc = zonesIncise(r.deb, r.fin);
        for (let x = r.deb; x < r.fin; x++) if (!inc.has(x)) map.set(x, c);
      }
      b = e + 1;
    }
    etat.couleurParMot = map;
    etat.baseCouleurPerso = baseCouleur;   // couleur de base par personnage (pour l'UI d'attribution)
  }

  // --- Décélération d'élocution (diction) ---
  const RE_FIN_NETTE = /["»”'’)\]]*$/;
  function coefElocution(i) {
    if (i < 0 || i >= etat.mots.length) return 1;
    if (!dansDialogue(i)) return 1;
    let j = i, signe = "";
    for (let k = 0; k < 6 && j < etat.mots.length; k++, j++) {
      const m = (etat.mots[j] || "").replace(RE_FIN_NETTE, "");
      const c = m.slice(-1);
      if ("…".indexOf(c) >= 0 || /[.,;:!?]/.test(c)) { signe = c; break; }
      if (estDebutPhrase(j + 1)) { j = -1; break; }
    }
    if (j < 0 || !signe) return 1;
    let paliers;
    if (signe === "!") paliers = [];
    else if (signe === "?") paliers = [0.4, 0.2];
    else if (signe === "," || signe === ";" || signe === ":") paliers = [0.4, 0.2];
    else paliers = [0.6, 0.4, 0.2];
    const dist = j - i;
    if (dist < 0 || dist >= paliers.length) return 1;
    return 1 + paliers[dist];
  }

  // Analyse TOUT le livre et recense les personnages qui parlent :
  //  - nommes : [{ cle, nom, count, genre, first }] triés par nombre de répliques
  //    (cle = nom normalisé pour l'attribution ; nom = libellé affiché ; first =
  //    index du mot de leur 1ʳᵉ réplique, pour l'anti-spoiler).
  //  - tiers : { M, F, total } (personnages descriptifs « un homme », « une femme »).
  function analyserPersonnages() {
    const mots = etat.mots;
    const res = { nommes: [], tiers: { M: 0, F: 0, total: 0 }, resolution: {} };
    if (!mots || !mots.length) { etat.persos = res; return res; }
    const debutBloc = (i) => i <= 0 || (etat.debutsPhrase && etat.debutsPhrase.has(i));
    // 1) Recense chaque PHRASE de nom détectée (« John Grey », « Grey », « John »…).
    const parPhrase = {};   // cle normalisée -> { tokens(orig), cleTokens, count, genre, first }
    for (let i = 0; i < mots.length; i++) {
      if (!(debutBloc(i) && DEBUT_REPLIQUE.test((mots[i] || "").trimStart()))) continue;
      let fin = i + 1; while (fin < mots.length && !debutBloc(fin)) fin++;
      const loc = locuteurDeReplique(i);
      if (loc.tiers) {
        res.tiers.total++;
        if (loc.genre === "M") res.tiers.M++; else if (loc.genre === "F") res.tiers.F++;
      } else if (loc.nom) {
        const tokens = loc.nom.split(/\s+/).filter(Boolean);
        const cleTokens = tokens.map(normCle);
        const cle = cleTokens.join(" ");
        if (cle) {
          if (!parPhrase[cle]) parPhrase[cle] = { tokens, cleTokens, count: 0, genre: "", first: i };
          parPhrase[cle].count++;
          if (loc.genre && !parPhrase[cle].genre) parPhrase[cle].genre = loc.genre;
        }
      }
      i = fin - 1;
    }
    // 2) Résolution : un mot seul rejoint un nom complet S'IL N'Y EN A QU'UN qui le
    //    contient (sinon homonymes → on le laisse distinct).
    const entries = Object.values(parPhrase);
    const multi = entries.filter((e) => e.tokens.length >= 2);
    const display = {};   // canon -> tokens(orig) du nom le plus complet
    multi.forEach((m) => { const c = m.cleTokens.join(" "); if (!display[c] || m.tokens.length > display[c].length) display[c] = m.tokens; });
    const canonDe = (e) => {
      if (e.tokens.length >= 2) return e.cleTokens.join(" ");
      const w = e.cleTokens[0];
      // On ne rattache un mot seul que s'il est le NOM DE FAMILLE (dernier mot)
      // d'un SEUL nom complet (« Fettes » → « John Fettes »). Un PRÉNOM seul
      // (« John ») reste distinct : trop ambigu (plusieurs John possibles).
      const conteneurs = [...new Set(
        multi.filter((m) => m.cleTokens[m.cleTokens.length - 1] === w).map((m) => m.cleTokens.join(" "))
      )];
      return conteneurs.length === 1 ? conteneurs[0] : w;
    };
    const final = {};
    entries.forEach((e) => {
      const c = canonDe(e);
      res.resolution[e.cleTokens.join(" ")] = c;
      const disp = (display[c] || e.tokens).join(" ");
      if (!final[c]) final[c] = { cle: c, nom: disp, count: 0, genre: "", first: Infinity };
      final[c].count += e.count;
      final[c].first = Math.min(final[c].first, e.first);
      if (e.genre && !final[c].genre) final[c].genre = e.genre;
      if (disp.length > final[c].nom.length) final[c].nom = disp;
    });
    res.nommes = Object.values(final).sort((a, b) => a.first - b.first);   // ordre d'apparition
    // 3) Enrichissement par la NARRATION : on déduit prénom↔nom à partir des noms
    //    propres ACCOLÉS dans tout le texte (« John Grey », « Ian Murray »). On
    //    n'enrichit que si une association est NETTEMENT dominante (anti-homonyme).
    const estPropre = (j) => { const n = motNu(mots[j]); return !!n && /\p{Lu}/u.test(n[0] || "") && nomValide(normCle(n)) && !TITRES.has(normCle(n)); };
    const suit = {}, prec = {};
    for (let j = 0; j < mots.length - 1; j++) {
      if (estDebutPhrase(j + 1)) continue;                 // pas à travers une fin de phrase
      if (!estPropre(j) || !estPropre(j + 1)) continue;
      const a = motNu(mots[j]), b = motNu(mots[j + 1]);
      const ca = normCle(a), cb = normCle(b);
      (suit[ca] = suit[ca] || {}); suit[ca][cb] = suit[ca][cb] || { n: 0, o: b }; suit[ca][cb].n++;
      (prec[cb] = prec[cb] || {}); prec[cb][ca] = prec[cb][ca] || { n: 0, o: a }; prec[cb][ca].n++;
    }
    const meilleurVoisin = (m, w) => {
      const d = m[w]; if (!d) return null;
      let best = null, tot = 0;
      for (const k in d) { tot += d[k].n; if (!best || d[k].n > best.n) best = d[k]; }
      return (best && best.n >= 2 && best.n >= tot * 0.5) ? best : null;   // nettement dominant
    };
    res.nommes.forEach((e) => {
      if (e.cle.indexOf(" ") >= 0) return;                 // déjà un nom complet
      const av = meilleurVoisin(prec, e.cle), ap = meilleurVoisin(suit, e.cle);
      if (av && (!ap || av.n >= ap.n)) e.nom = av.o + " " + e.nom;          // prénom devant (« John » + « Grey »)
      else if (ap) e.nom = e.nom + " " + ap.o;                              // nom derrière (« Ian » + « Murray »)
    });
    etat.persos = res;   // cache mémoire (réutilisé par calculerLocuteurs + l'UI)
    return res;
  }

  // Interface exposée au noyau.
  window.MoteurDialogues = { calculerLocuteurs, coefElocution, analyserPersonnages };
})();
