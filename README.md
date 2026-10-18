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

Les liens d’activité habituels ne changent pas. Dans **Outils → Activité du cours**, choisir l’activité exacte : seules ses pages reçoivent les alertes, consignes, minuteur et correction. Les autres activités restent inactives. Sans sélection, rien n’est transmis aux élèves. Le choix est partagé entre les appareils professeur ; seul le pilote peut le modifier. Changer d’activité retire l’ancienne correction, la consigne et le minuteur. La projection et le micro restent utilisables.

Une page ouverte chez soi sur cette même activité reste concernée : le choix distingue les activités, pas la position des élèves. Quand le dernier appareil professeur se déconnecte, la liaison s’arrête ; sans réseau, elle expire au plus tard après 35 secondes. Un appareil suiveur reste relié aux activités même quand le pilote est fermé.

Dans la version personnelle, le minuteur, les consignes et le texte de l’alerte sont aussi envoyés aux activités. Le minuteur apparaît dans un coin et suit les pauses, reprises et remises à zéro du professeur. Cliquer sur le nombre de connexions affiche leur répartition par activité. Il s’agit de pages ouvertes, pas de personnes : plusieurs onglets peuvent compter plusieurs fois. Ce détail reste réservé au professeur. La version à partager affiche les outils uniquement sur la projection.

### Diffuser la correction

Dans la version personnelle, choisir l’activité du cours puis ouvrir **Outils → Correction → Afficher la correction**. Il faut être connecté comme professeur, piloter les écrans et avoir activé **Lier mes activités**. Le bouton suit le même état sur les appareils professeur.

Seule l’activité choisie affiche son PDF **Corrigé élève**, au-dessus de la page. Chaque élève peut changer de page et régler le zoom indépendamment. **Retour à l’activité** permet de reprendre l’exercice ; **Revoir la correction** rouvre le document tant que le professeur le laisse disponible. Le document projeté par le professeur reste inchangé.

**Masquer la correction** retire le lecteur et bloque les nouvelles lectures du PDF. Désactiver la liaison aux activités ou déconnecter le dernier appareil professeur coupe aussi cet accès ; en cas de perte réseau, il expire sous 35 secondes. Une copie déjà reçue ne peut pas être effacée à distance. Cette fonction est absente de la version à partager.

### Limiter les échanges Cloudflare

La mesure et la jauge du micro restent uniquement sur l'appareil qui écoute. Aucun niveau sonore n'est transmis : seuls les changements d'alerte sont envoyés immédiatement. Les commandes identiques ne sont pas répétées. Sans commande récente confirmée, un message de présence toutes les 15 secondes conserve la connexion ; les minuteurs continuent de décompter directement dans chaque navigateur.

Le relais évite les écritures et reprogrammations d'alarme inutiles. Les données nécessaires aux droits, à la reprise après veille du serveur et à l'expiration restent conservées. La liaison expire toujours sous 35 secondes après le dernier contact professeur. Les quotas gratuits sont partagés avec les autres usages du compte Cloudflare ; les messages sur une connexion WebSocket ouverte ne sont pas des nouvelles requêtes HTTP Workers.

Les tests du relais simulent 6 heures, 30 activités connectées, deux appareils professeur, 360 changements d'alerte et des reprises du serveur : environ 5 400 écritures SQL et d'alarme, avec un majorant de 10 100 en doublant les écritures SQL pour les index. Cette simulation sert de contrôle de régression ; elle ne remplace pas les compteurs de facturation Cloudflare. Les tests vérifient aussi qu'aucun changement de niveau sonore ne provoque un envoi et que les alertes restent immédiates.

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

`server/relay/correction-assets/` reste exclu de Git et de GitHub Pages. Seul `server/relay/src/corrections-catalog.js` est versionné. Le relais sert ces PDF par son binding interne : les chemins bruts restent fermés, et `/correction?activity=…` exige une diffusion autorisée pour l’activité choisie avec au moins un appareil professeur actif. Les réponses sont envoyées sans mise en cache. Conserver `assets.run_worker_first: true` dans la configuration du relais pour protéger tous les chemins des fichiers.

La préparation actualise aussi `public/activities.js`, qui contient uniquement les identifiants et titres des activités pour le sélecteur professeur. Pour régénérer cette liste depuis le catalogue existant sans recopier les PDF, lancer `node server/relay/scripts/write-activities.mjs`.

## Ouvrir une séance depuis son dossier

Les liens `?activity=projets/5&seance=2` (ou `exposes/5`, ou une activité telle que `5/07`) préparent le cours demandé. Après connexion professeur, le pilote sélectionne cette activité, active sa liaison et ouvre sa page. Un appareil suiveur doit prendre la main ; le lien ne change jamais ses droits. Les guides de groupes proposent seulement des consignes, aides et simulations ; aucune réponse élève n’y est saisie ou enregistrée. Les guides n’ont pas de corrigé à diffuser.
