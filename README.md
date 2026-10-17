# Classe calme

Page web de projection : plusieurs PDF et pages web, jauge de bruit réglable, alerte rouge et plein écran. Aucune installation sur les postes.

**Ouvrir : https://jean-marie-cardoso.github.io/classe-calme/**

**Version à partager aux collègues : https://jean-marie-cardoso.github.io/classe-calme/partage/**

Cette seconde adresse propose la projection, les onglets, le micro et les alertes locales. Elle ne charge ni connexion professeur, ni relais, ni liaison aux activités. Aucun compte n’est nécessaire. Les mêmes fichiers d’affichage et de mesure sonore sont partagés entre les deux versions.

Les PDF et le son sont traités dans le navigateur. Le micro demande son autorisation habituelle. Aucun son ni PDF n’est envoyé au relais.

Le bouton **Outils** ouvre le minuteur, les profils Silence / Binômes / Groupes, les consignes temporaires et le texte personnalisable de l’alerte. Les seuils restent dans cet ordre, du plus bas au plus haut, y compris après un réglage manuel. Les seuils et le texte sont mémorisés dans le navigateur. La poignée permet de déplacer la barre ; **−** la réduit à la jauge et aux indicateurs utiles. Ces outils sont présents dans les deux versions.

## Activités des élèves

Les pages du [labo techno](https://jean-marie-cardoso.github.io/labo-techno/) reçoivent automatiquement les alertes. Pour autoriser l’envoi, la page professeur utilise la connexion privée existante de Classe calme, puis revient sur GitHub. L’autorisation dure au maximum huit heures dans cet onglet. Le bouton « Connecter » des réglages permet de la renouveler. La projection et le micro fonctionnent aussi sans liaison.

Les liens d’activité habituels ne changent pas. La liaison est commune à toutes les activités : une activité ouverte hors de la salle peut aussi recevoir l’alerte. Quand le professeur ferme la page, l’alerte est libérée ; sans réseau, elle expire au plus tard après 35 secondes.

Dans la version personnelle, le minuteur, les consignes et le texte de l’alerte sont aussi envoyés aux activités. Le minuteur apparaît dans un coin et suit les pauses, reprises et remises à zéro du professeur. Cliquer sur le nombre de connexions affiche leur répartition par activité. Il s’agit de pages ouvertes, pas de personnes : plusieurs onglets peuvent compter plusieurs fois. Ce détail reste réservé au professeur. La version à partager affiche les outils uniquement sur la projection.

## Sources et publication

- `public/` : page GitHub Pages, publiée automatiquement depuis `main`.
- `server/relay/` : relais Cloudflare existant. Les droits d’envoi sont vérifiés par le serveur ; les pages élèves restent en lecture seule.
- `server/private-bridge.js` : source de la passerelle privée existante qui autorise le professeur. Ce fichier est un modèle compilé par le projet Sites ; il n’est pas exécuté par GitHub Pages.

Aucun secret n’est présent dans ce dépôt. Les valeurs privées restent dans la configuration des serveurs. GitHub Pages héberge uniquement l’interface ; le relais reste nécessaire pour joindre des PC différents.
