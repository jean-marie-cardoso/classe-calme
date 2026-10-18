# Classe calme

Page web de projection : plusieurs PDF et pages web, jauge de bruit réglable, alerte rouge et plein écran. Aucune installation sur les postes.

**Ouvrir : https://jean-marie-cardoso.github.io/classe-calme/**

**Version à partager aux collègues : https://jean-marie-cardoso.github.io/classe-calme/partage/**

Cette seconde adresse propose la projection, les onglets, le micro et les alertes locales. Elle ne charge ni connexion professeur, ni relais, ni liaison aux activités. Aucun compte n’est nécessaire. Les mêmes fichiers d’affichage et de mesure sonore sont partagés entre les deux versions.

Le son reste dans le navigateur : aucun enregistrement ni son envoyé. Le micro demande son autorisation habituelle. Dans la version personnelle connectée, les PDF sont transmis au relais privé pour les afficher sur les autres appareils autorisés. La version à partager conserve les PDF uniquement sur le poste.

Le bouton **Outils** ouvre le minuteur, les profils Silence / Binômes / Groupes, les consignes temporaires et le texte personnalisable de l’alerte. Les seuils restent dans cet ordre, du plus bas au plus haut, y compris après un réglage manuel. Les seuils et le texte sont mémorisés dans le navigateur. La poignée permet de déplacer la barre ; **−** la réduit à la jauge et aux indicateurs utiles. Ces outils sont présents dans les deux versions.

## Mac et vidéoprojecteur

1. Ouvrir la version personnelle sur chaque appareil et saisir le même mot de passe professeur.
2. Le premier appareil pilote. Les autres affichent le même document en vue projection.
3. **Prendre la main** permet de changer le document depuis un autre appareil.
4. **Activer micro** choisit le micro de cet appareil. Le dernier micro activé remplace le précédent, indépendamment de la télécommande.

Les onglets PDF et web, la page et le zoom du PDF, le minuteur, les consignes et les alertes suivent le pilote. Les réglages restent accessibles dans la barre. Le véritable plein écran nécessite un clic sur **Projeter** sur chaque appareil, selon les règles du navigateur.

Un site intégré reste utilisable directement sur le PC. Les clics et défilements à l’intérieur d’un site ne sont pas reproduits sur les autres écrans. Certains sites refusent l’affichage intégré : **Ouvrir à part** permet de les ouvrir dans un autre onglet, hors de la projection synchronisée.

Les PDF chargés pour la projection sont réservés aux appareils connectés avec le mot de passe. Les pages élèves ne les reçoivent pas. Ces PDF sont limités à 15 Mio par fichier, avec un stockage temporaire de 60 Mio par salle. Sans connexion professeur, la projection locale reste utilisable.

## Activités des élèves

Les pages du [labo techno](https://jean-marie-cardoso.github.io/labo-techno/) reçoivent automatiquement les alertes. Le bouton **Connexion prof** demande le mot de passe du professeur pour autoriser l’envoi. Aucun compte OpenAI n’est nécessaire. L’autorisation dure au maximum huit heures dans cet onglet ; **Déconnexion** la révoque. La projection et le micro fonctionnent aussi sans connexion.

L’adresse et le code sont publics. Le mot de passe et la vérification des droits restent côté serveur : ouvrir le lien ne permet pas de commander les activités. Les élèves n’ont aucun mot de passe à saisir.

Les liens d’activité habituels ne changent pas. La liaison est commune à toutes les activités : une activité ouverte hors de la salle peut aussi recevoir l’alerte. Quand le dernier appareil professeur se déconnecte, la liaison s’arrête ; sans réseau, elle expire au plus tard après 35 secondes. Un appareil suiveur reste relié aux activités même quand le pilote est fermé.

Dans la version personnelle, le minuteur, les consignes et le texte de l’alerte sont aussi envoyés aux activités. Le minuteur apparaît dans un coin et suit les pauses, reprises et remises à zéro du professeur. Cliquer sur le nombre de connexions affiche leur répartition par activité. Il s’agit de pages ouvertes, pas de personnes : plusieurs onglets peuvent compter plusieurs fois. Ce détail reste réservé au professeur. La version à partager affiche les outils uniquement sur la projection.

### Diffuser la correction

Dans la version personnelle, ouvrir **Outils → Correction → Afficher la correction**. Il faut être connecté comme professeur, piloter les écrans et avoir activé **Lier mes activités**. Le bouton suit le même état sur les appareils professeur.

Chaque activité affiche son propre PDF **Corrigé élève**, au-dessus de la page. Chaque élève peut changer de page et régler le zoom indépendamment. **Retour à l’activité** permet de reprendre l’exercice ; **Revoir la correction** rouvre le document tant que le professeur le laisse disponible. Le document projeté par le professeur reste inchangé.

**Masquer la correction** retire le lecteur et bloque les nouvelles lectures du PDF. Désactiver la liaison aux activités ou déconnecter le dernier appareil professeur coupe aussi cet accès ; en cas de perte réseau, il expire sous 35 secondes. Une copie déjà reçue ne peut pas être effacée à distance. Cette fonction est absente de la version à partager.

## Sources et publication

- `public/` : page GitHub Pages, publiée automatiquement depuis `main`.
- `server/relay/` : relais Cloudflare existant. Les droits d’envoi sont vérifiés par le serveur ; les pages élèves restent en lecture seule.

Aucun secret n’est présent dans ce dépôt. Les valeurs privées restent dans la configuration des serveurs. GitHub Pages héberge uniquement l’interface ; le relais reste nécessaire pour joindre des PC différents.

Le relais utilise deux secrets Cloudflare : `TEACHER_PASSWORD_HASH` (empreinte PBKDF2-SHA-256 salée, format `pbkdf2-sha256:100000:<sel hex32>:<empreinte hex64>`) et `TEACHER_AUTH_SECRET` (clé aléatoire de signature d’au moins 32 caractères). Le mot de passe n’est pas enregistré dans le navigateur. Les tentatives de connexion sont limitées et les sessions sont révocables côté serveur. Pour révoquer toutes les autorisations lors d’un changement de mot de passe, renouveler aussi la clé de signature.

La synchronisation des appareils utilise une connexion professeur distincte des pages élèves. Le pilote de l’affichage et la source du micro ont chacun leur propre droit temporaire. Le transfert des PDF de projection est authentifié et fractionné ; ces fichiers ne sont jamais publiés dans GitHub ni transmis par les connexions élèves.

### Préparer les corrigés privés

Les corrigés sont préparés depuis les PDF `02_Corrige_eleve_Pronote_…` du dossier des cours. Le catalogue associe chaque activité à sa correction exacte ; il contient uniquement les titres, chemins internes, tailles et empreintes des fichiers.

Depuis la racine de ce dépôt, définir `COURSE_ROOT` avec le dossier local des cours et `CORRECTIONS_MANIFEST` avec le fichier `links.json` du dépôt `jmtechno`, puis lancer :

```sh
node server/relay/scripts/prepare-corrections.mjs "$COURSE_ROOT" "$CORRECTIONS_MANIFEST"
```

Relancer cette préparation puis publier le relais après une modification des corrigés. Le script vérifie toutes les correspondances avant de remplacer les fichiers préparés. Il refuse les PDF invalides, les fichiers supérieurs à 15 Mio et un ensemble supérieur à 60 Mio.

`server/relay/correction-assets/` reste exclu de Git et de GitHub Pages. Seul `server/relay/src/corrections-catalog.js` est versionné. Le relais sert ces PDF par son binding interne : les chemins bruts restent fermés, et `/correction?activity=…` exige une diffusion autorisée avec au moins un appareil professeur actif. Les réponses sont envoyées sans mise en cache. Conserver `assets.run_worker_first: true` dans la configuration du relais pour protéger tous les chemins des fichiers.
