# Classe calme

Page web de projection : plusieurs PDF et pages web, jauge de bruit réglable, alerte rouge et plein écran. Aucune installation sur les postes.

**Ouvrir : https://jean-marie-cardoso.github.io/classe-calme/**

Les PDF et le son sont traités dans le navigateur. Le micro demande son autorisation habituelle. Aucun son ni PDF n’est envoyé au relais.

## Activités des élèves

Les pages du [labo techno](https://jean-marie-cardoso.github.io/labo-techno/) reçoivent automatiquement les alertes. Pour autoriser l’envoi, la page professeur utilise la connexion privée existante de Classe calme, puis revient sur GitHub. L’autorisation dure au maximum huit heures dans cet onglet. Le bouton « Connecter » des réglages permet de la renouveler. La projection et le micro fonctionnent aussi sans liaison.

Les liens d’activité habituels ne changent pas. La liaison est commune à toutes les activités : une activité ouverte hors de la salle peut aussi recevoir l’alerte. Quand le professeur ferme la page, l’alerte est libérée ; sans réseau, elle expire au plus tard après 35 secondes.

## Sources et publication

- `public/` : page GitHub Pages, publiée automatiquement depuis `main`.
- `server/relay/` : relais Cloudflare existant. Les droits d’envoi sont vérifiés par le serveur ; les pages élèves restent en lecture seule.
- `server/private-bridge.js` : source de la passerelle privée existante qui autorise le professeur. Ce fichier est un modèle compilé par le projet Sites ; il n’est pas exécuté par GitHub Pages.

Aucun secret n’est présent dans ce dépôt. Les valeurs privées restent dans la configuration des serveurs. GitHub Pages héberge uniquement l’interface ; le relais reste nécessaire pour joindre des PC différents.
