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
      if (estVerbe(a) && !aPronom(a) && /\p{Lu}/u.test((nb[0] || "")) && !estVerbe(b)) return { nom: nb, genre, tiers: false };
      if (/\p{Lu}/u.test((na[0] || "")) && !estVerbe(a) && estVerbe(b) && !aPronom(b)) return { nom: na, genre, tiers: false };
      if (k === fin) {
        const estV = estVerbe(a) || (finForte && !estVerbe(a) && /^\p{Ll}/u.test(na));
        if (estV && ARTICLE_INDEFINI.test(nb.toLowerCase())) {
          const nc = motNu(mots[k + 2] || "");
          if (nc) return { nom: (na + " " + nc).toLowerCase(), genre: "", tiers: true };
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
    const debutBloc = (i) => i <= 0 || (etat.debutsPhrase && etat.debutsPhrase.has(i));

    const repliques = []; const compte = {};
    for (let i = 0; i < mots.length; i++) {
      if (!(debutBloc(i) && DEBUT_REPLIQUE.test((mots[i] || "").trimStart()))) continue;
      let fin = i + 1; while (fin < mots.length && !debutBloc(fin)) fin++;
      const loc = locuteurDeReplique(i);
      const nom = loc.tiers ? "" : (window.Chargeur ? Chargeur.normTitre(loc.nom) : loc.nom);
      if (nom) compte[nom] = (compte[nom] || 0) + 1;
      repliques.push({ deb: i, fin, nom, genre: loc.genre || "", tiers: !!loc.tiers });
      i = fin - 1;
    }
    if (!repliques.length) { etat.couleurParMot = map; return; }

    let principal = "", max = 0;
    for (const n in compte) if (compte[n] > max) { max = compte[n]; principal = n; }
    // Genre connu d'un nom (si une de ses répliques portait un pronom).
    const genreNom = {};
    for (const r of repliques) if (r.nom && r.genre && !genreNom[r.nom]) genreNom[r.nom] = r.genre;

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
      const estPrinc = (v) => voixNom[v] && voixNom[v] === principal;
      const couleurVoix = (v) => {
        if (v === -1) return COUL_SEC2;                 // tiers
        if (estPrinc(v)) return COUL_PRINCIPAL;
        if (estPrinc(1 - v)) return COUL_SEC1;          // l'autre voix est le principal
        return v === 0 ? COUL_PRINCIPAL : COUL_SEC1;    // pas de principal identifié
      };
      for (let k = b; k <= e; k++) {
        const c = couleurVoix(idx[k]); const r = repliques[k];
        const inc = zonesIncise(r.deb, r.fin);
        for (let x = r.deb; x < r.fin; x++) if (!inc.has(x)) map.set(x, c);
      }
      b = e + 1;
    }
    etat.couleurParMot = map;
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

  // Interface exposée au noyau.
  window.MoteurDialogues = { calculerLocuteurs, coefElocution };
})();
