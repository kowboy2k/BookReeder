# BookReeder

Lecteur d'ebooks en **lecture rapide** (RSVP / façon Spritz), multiplateforme et **hors-ligne**.
Cible : PC (Windows 11), Mac, iPhone (iOS) et liseuse Vivlio (Android).

## Choix d'architecture
- **App web / PWA** : une seule base de code pour les 4 plateformes (validé avec Kev).
- HTML + JavaScript pur, **sans framework** (léger, marche même sur la Vivlio).
- Fonctionne **hors-ligne** via service worker + manifeste (installable comme une appli).
- Lecture EPUB avec la librairie `epub.js` (+ `jszip`), embarquées localement dans `lib/`.

## Fichiers clés
- `index.html` — structure (écran accueil / écran lecture / panneau réglages)
- `app.js` — tout le moteur : chargement EPUB, découpe en mots, RSVP, ORP, lecture auto
- `style.css` — thème sombre, centrage ORP via `--decalage-orp`
- `sw.js` + `manifest.webmanifest` — PWA / hors-ligne
- `lib/epub.min.js`, `lib/jszip.min.js` — lecture des EPUB

## Décisions / points subtils
- **Rythme de lecture** (`delaiChunk`) : la durée d'un groupe est proportionnelle à la
  **longueur réelle** des mots (≈ caractères/5,5 × base) → mots longs s'attardent, courts
  défilent vite. + respirations : fin de phrase (+2×base), virgule/`;`/`:` (+1×base), et
  **pause d'échange** (+3×base) quand le groupe suivant ouvre une réplique de dialogue
  (commence par un tiret ou un guillemet ouvrant). Donne un rythme dialogue vs descriptif.
- **Bionic reading** (`bornesGras`) : met en gras le **début du mot** (point de fixation),
  à partir de la 1re lettre (jamais sur un tiret/guillemet de tête), sur une fraction des
  lettres selon la longueur (court ≤3→1, ≤6→2, ≤9→3, sinon ~40 %). Le cerveau complète la fin.
- **Choix de la lettre ORP** (`calculerOrp` + `rangPivot`) : suit la table Spritz/OpenSpritz —
  le pivot est légèrement à gauche du centre, et son rang dépend du nombre de **lettres** :
  1→1ʳᵉ, 2–5→2ᵉ, 6–9→3ᵉ, 10–13→4ᵉ, 14+→5ᵉ. On ne compte QUE lettres/chiffres (`\p{L}\p{N}`)
  donc le repère ne tombe jamais sur une apostrophe, un tiret, un guillemet ou une ponctuation.
- **Centrage ORP** : `#mot-affiche` est positionné en `absolute left:50%` et décalé par
  `--decalage-orp` (= distance bord gauche → centre de la lettre pivot) pour que la lettre
  rouge tombe pile au centre de l'écran, sous les réticules. NE PAS revenir à un centrage
  par `text-align` (le mot partait à droite).
- **Découpe des mots** (`decouperEnMots`) : garde les apostrophes internes (`L'homme`),
  rattache la ponctuation **ouvrante** (« " ' ( [) au mot suivant et la **fermante**
  (» " ' ) ] . , ; : ! ? …) au mot précédent — important pour la typo française (espace
  avant ; : ! ?) afin de ne jamais afficher un signe seul.
- **Service worker** : **réseau d'abord** (network-first) — en ligne il charge toujours la
  dernière version et rafraîchit le cache ; hors-ligne il retombe sur le cache. Évite les
  vieilles versions resservies. Bumper quand même `CACHE = "bookreeder-vN"` à chaque modif.

## Lancement / test
Serveur local (config preview centralisée `C:\Claude Code\.claude\launch.json`, nom `bookreeder`) :
`python -m http.server 8765 --directory "Projets/BookReeder"`

## Navigation & bibliothèque
- **Boutons** : `⏮` / `−` / `▶` / `+` / `⏭` / `☰` / `⚙` / `✖`. `−` et `+` ajustent la vitesse par
  paliers de 50 mots/min (bornes 200–800). `⏮`/`⏭` = retour/avance rapide par `etat.pasNav`
  (défaut 10, slider 5–50 dans les réglages). `☰` ouvre le panneau de navigation. `✖` revient
  à l'accueil. Vitesse affichée sous les boutons.
- **Curseur** : pastille ronde déplaçable sur la barre (`pointerdown/move/up`, souris + tactile).
- **Repères de chapitres** : petits traits sur la barre au début de chaque chapitre. La ligne
  d'info affiche `chapitre · % · index / total`. Cliquer dessus (ou le bouton `☰`) ouvre le
  **panneau de navigation** (menu déroulant des chapitres + slider de position en %).
- **Chapitres (repérage rigoureux)** : la TOC (`livre.loaded.navigation`) est la source
  principale. Chaque entrée pointe vers une section et parfois une **ancre `#id`** ; on calcule
  alors le nombre de mots avant cette ancre (Range `setEndBefore` + `decouperEnMots`) pour caler
  le chapitre au bon mot, même si plusieurs chapitres sont dans le même fichier. Replis : une
  entrée par section, puis « Passage N » tous les 1500 mots. Repère « Début » garanti à 0.
- **Boutons chapitre** : `⏮`/`⏭` (sélecteur de variation `&#xFE0E;` pour rester monochrome)
  vont toujours au **début** du chapitre précédent/suivant ; `⏮` revient d'abord au début du
  chapitre courant si on y est déjà engagé. **Sans chapitrage** (`chapitragePresent()` faux,
  c.-à-d. un seul repère) : saut de **1000 mots**.
- **Boutons phrase** : `⏪`/`⏩` = phrase précédente / suivante. `⏪` revient au début de la phrase
  en cours, puis au début des phrases précédentes ; `⏩` va au début de la phrase suivante.
  Début de phrase = mot dont le précédent valide `FIN_PHRASE`. (Remplace l'ancien saut en mots.)
- **Écran principal = tout relatif au chapitre courant** : barre, position et `%` portent sur le
  chapitre (`60 / 123 mots`). La **position dans le livre entier** (barre + `%`) est dans le
  panneau de navigation uniquement.
- **Découpe d'affichage** : max **4 mots** ; un mot > 12 caractères s'affiche seul ; on ne
  regroupe jamais après une fin de phrase (`FIN_PHRASE`, évite « fin. Début ») ; la police est
  réduite automatiquement si le groupe dépasse le cadre (`ajusterTaillePolice`).
- **Cartouche** : largeur automatique selon le nombre de mots affichés
  (`ajusterCadre` → `--cadre-largeur = min((88+2n)%, (440+140n)px)`, n = 1–4) — plus de mots,
  plus large. `ajusterTaillePolice` réduit ensuite la police si besoin en tenant compte du
  décalage ORP (le plus grand côté autour du repère doit tenir dans la moitié du cadre) : rien
  ne déborde jamais.
- **Continuer après saut** : option (cochée par défaut) — `deplacer(pas, true)` relance la
  lecture après avance/retour/chapitre sans casser le rythme.
- **Bibliothèque (IndexedDB, base `bookreeder`, store `livres`)** : chaque livre chargé est
  stocké découpé (mots + chapitres + position), repris instantanément au clic depuis l'accueil
  sans relire l'EPUB. Affiche nom, date d'ajout (JJ/MM/AAAA HH:MM:SS) et % de progression ;
  petit `×` pour retirer. La position est sauvée à la pause, à la fermeture et au glissé.

## Jalons
- **Jalon 1 (FAIT)** : charger un EPUB, RSVP 1–8 mots, vitesse 200–800 mpm, ORP activable,
  découpe intelligente, contrôles clavier + tactile, base PWA hors-ligne.
- **Jalon 2 (FAIT)** : bionic reading + couleurs, polices/graisse/espacements, boutons −/+ vitesse,
  curseur déplaçable, bibliothèque persistante, extraction des chapitres + navigation.
- **Jalon 3 (à venir)** : couleurs fond/texte personnalisables, réglage fin des pauses par
  ponctuation, mode allégé Vivlio, support PDF (best effort).
