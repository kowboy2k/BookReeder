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
- **Centrage ORP** : `#mot-affiche` est positionné en `absolute left:50%` et décalé par
  `--decalage-orp` (= distance bord gauche → centre de la lettre pivot) pour que la lettre
  rouge tombe pile au centre de l'écran, sous les réticules. NE PAS revenir à un centrage
  par `text-align` (le mot partait à droite).
- **Découpe des mots** (`decouperEnMots`) : garde les apostrophes internes (`L'homme`),
  rattache la ponctuation **ouvrante** (« " ' ( [) au mot suivant et la **fermante**
  (» " ' ) ] . , ; : ! ? …) au mot précédent — important pour la typo française (espace
  avant ; : ! ?) afin de ne jamais afficher un signe seul.
- **Service worker** : cache-first. En cas de modif non prise en compte pendant le dev,
  vider le cache + désinscrire le SW, puis recharger (ou bumper `CACHE = "bookreeder-vN"`).

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
- **Boutons chapitre** : `⏮`/`⏭` (avec sélecteur de variation `&#xFE0E;` pour rester monochrome)
  vont au chapitre précédent/suivant ; `⏮` revient d'abord au début du chapitre courant si on y
  est déjà engagé. `⏪`/`⏩` = retour/avance rapide par `etat.pasNav`.
- **Barre principale = chapitre courant** ; la **barre du livre entier** (avec repères de
  chapitre) est dans le panneau de navigation. Le `%` du texte d'info reste celui du livre entier.
- **Découpe d'affichage** : max **4 mots** ; un mot > 12 caractères s'affiche seul ; on ne
  regroupe jamais après une fin de phrase (`FIN_PHRASE`, évite « fin. Début ») ; la police est
  réduite automatiquement si le groupe dépasse le cadre (`ajusterTaillePolice`).
- **Cartouche** : taille Auto (`min(90%,600px)`, défaut) ou Manuelle (slider `--cadre-largeur`).
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
