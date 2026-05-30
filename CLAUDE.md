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

## Jalons
- **Jalon 1 (FAIT)** : charger un EPUB, RSVP 1–8 mots, vitesse 200–800 mpm, ORP activable,
  découpe intelligente, contrôles clavier + tactile, base PWA hors-ligne.
- **Jalon 2 (à venir)** : couleurs fond/texte personnalisables, bionic reading, polices,
  réglage fin des pauses par ponctuation, mode allégé Vivlio, support PDF (best effort).
