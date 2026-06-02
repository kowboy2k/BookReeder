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

  // Construit la liste affichée selon le mode :
  //  - "existante" : TOC d'origine nettoyée (couvertures coupées, numéros corrigés).
  //  - "optimisee" : Avant-propos · (préface/prologue/intro gardés) · chapitres ·
  //                  (épilogue gardé) · Annexes.
  function construireTOC(brut, mode) {
    if (!brut || !brut.length) return brut || [];
    let chaps = nettoyer(brut).filter((c) => categorie(c.titre) !== "couv");
    if (!chaps.length) chaps = [{ titre: "Début", debut: 0 }];
    if (mode !== "optimisee") return chaps;

    const cat = chaps.map((c) => categorie(c.titre));
    const estDebut = (i) => cat[i] === "ouverture" || cat[i] === "chapitre";
    const estFin = (i) => cat[i] === "chapitre" || cat[i] === "epilogue";
    let i0 = -1; for (let i = 0; i < chaps.length; i++) if (estDebut(i)) { i0 = i; break; }
    let i1 = -1; for (let i = chaps.length - 1; i >= 0; i--) if (estFin(i)) { i1 = i; break; }
    if (i0 < 0) return chaps;   // aucun contenu identifié → on ne touche pas

    const out = [];
    if (i0 > 0) out.push({ titre: "Avant-propos", debut: chaps[0].debut });   // tout avant le 1er contenu
    for (let i = i0; i <= i1; i++) out.push({ titre: chaps[i].titre, debut: chaps[i].debut });
    if (i1 < chaps.length - 1) out.push({ titre: "Annexes", debut: chaps[i1 + 1].debut });
    return out;
  }

  window.Chargeur = { construireTOC, aTOCReelle, categorie };
})();
