// URL d'accueil de l'app web (front) qui héberge les pages publiques utilisées
// dans les emails transactionnels : acceptation d'invitation, réinitialisation
// de mot de passe… En V1 on hard-code ; à terme on basculera vers une variable
// d'env (`WEB_APP_URL`). Centralisé ici pour être partagé entre services.
export const WEB_APP_BASE_URL = 'https://gestion-locative.zeleph.fr';
