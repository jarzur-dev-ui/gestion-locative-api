# Sécurité

Référence des mécanismes de sécurité de l'API. Voir aussi `docs/audit-plan.md` (remédiation audit).

## Authentification — mots de passe

- Hash **argon2id** via `@node-rs/argon2`. Paramètres : `src/modules/auth/password.ts:ARGON2_OPTS`
  (`memoryCost` 19 456 KiB, `timeCost` 2, `parallelism` 1, `outputLen` 32). Réf OWASP.
- `verifyPassword` renvoie `false` sur exception (jamais de throw qui fuite).
- **Anti-énumération** : login renvoie un `401 Identifiants invalides` **uniforme** que l'email existe
  ou non (`auth.service.ts:authenticateByEmailAndPassword`). Le « mot de passe oublié » répond
  toujours `204` et n'envoie un email que si le compte existe **et** a déjà un `passwordHash`
  (`password-reset.service.ts:requestPasswordReset`).
- Emails normalisés (`toLowerCase().trim()`) avant lookup.

## Sessions

- Token **opaque de 256 bits** : `randomBytes(32).toString('base64url')`
  (`session.service.ts:generateSessionToken`). Sert d'ID en table `sessions` ET de valeur de cookie.
  Aucun JWT, aucune donnée signée côté client.
- Cookie `gl_session` : `HttpOnly`, `SameSite=Lax`, `path=/`, `maxAge` 30 j, `Secure` **en prod**
  uniquement (`setSessionCookie`).
- TTL 30 j, sliding-window (`lastSeenAt` bumpé à chaque requête authentifiée) ; session expirée
  supprimée à la lecture. Reset de mot de passe → invalidation des sessions de l'utilisateur.
- Middleware `session` passif (charge user/session) + `requireAuth`/`requireRole` (refus). Réf :
  `src/middleware/`.

## Rate limiting

`src/lib/rate-limit.ts` (hono-rate-limiter, clé = IP) :
- **global** : 100 req/min/IP sur tout `*`.
- **sensible** : 10 req/min/IP sur les routes non authentifiées à risque — `/api/auth/login`,
  `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/invitations/accept`, `/share/*`
  (enregistrées dans `src/index.ts`).
- **Résolution IP derrière proxy** (`resolveClientIp`) : l'app tourne derrière **un** reverse-proxy de
  confiance qui ajoute l'IP réelle en **fin** de `X-Forwarded-For`. On prend l'entrée la plus à droite
  (`TRUSTED_HOPS = 1`) — jamais la plus à gauche (spoofable par le client). Fallback : socket TCP.
  ⚠️ À ajuster (`TRUSTED_HOPS`) si l'on ajoute un CDN / second proxy devant.

## Upload de fichiers

`src/lib/storage.ts` :
- **Validation MIME par magic bytes** (`assertContentMatchesDeclaredMime` via `file-type`) : le type
  réel du contenu doit être dans l'allowlist `ALLOWED_MIME_TYPES` (pdf, jpeg, png, webp) **et**
  correspondre au type déclaré (sinon `MimeMismatchError`). Défense contre l'exécutable/HTML déguisé.
- Taille bornée (`MAX_UPLOAD_BYTES` = 20 Mo) + quota par bailleur (`storageQuotaBytes`).
- **Anti path-traversal** (`resolveSafePath`) : tout chemin est résolu sous `STORAGE_ROOT` et rejeté
  s'il en sort. Stockage sous `<year>/<month>/<uuid>.<ext>` (nom généré, jamais le nom client).
- Le téléchargement public sanitize le `Content-Disposition` (`share-public.routes.ts:sanitizeFilename`,
  RFC 5987). Les réponses fichiers doivent porter `X-Content-Type-Options: nosniff`.

## CORS

`app.use('*', cors({ origin: env.CORS_ORIGIN, credentials: true }))` (`src/index.ts`).
Origine unique configurée par `CORS_ORIGIN` (validée URL dans `src/config/env.ts`) ; cookies
cross-origin autorisés (`credentials`).

## Secrets — SOPS / age

- Secrets prod **chiffrés** dans `secrets/prod.env` (règle `.sops.yaml`, recette age). Safe à committer.
- Clé **privée** age **hors repo** : `~/.config/sops/age/keys.txt` (chmod 600), présente sur le Mac et
  le VPS, jamais commitée. `SOPS_AGE_KEY_FILE` exporté dans le `~/.zshrc` du Mac.
- Éditer : `sops secrets/prod.env`. Variables d'env validées au boot par Zod (`src/config/env.ts`) —
  l'app crash si une variable requise (`DATABASE_URL`, `CORS_ORIGIN`) manque.
- SSL DB auto si l'hôte n'est pas local (`db/client.ts:shouldUseSsl`). En prod, `SMTP_HOST` manquant
  fait throw le mailer (pas d'envoi silencieux).

## Tokens de partage & expiration

- Partages publics : token opaque 256 bits (PK), TTL **défaut 7 j / max 30 j**
  (`document-shares.schemas.ts`). `GET /share/{token}` renvoie **410** si expiré, révoqué (`revokedAt`)
  ou inconnu — sans révéler la cause. Tokens masqués dans les logs (`maskToken`).
- Invitations : token opaque 256 bits, TTL 7 j, `usedAt` à l'acceptation. Reset password : TTL 1 h.

## Audit

`src/lib/audit.ts` — toutes les actions sensibles sont journalisées dans `audit_logs` (acteur user /
scheduler / system, IP + user-agent pour un user). **Best-effort** : un échec d'insertion ne casse
jamais la requête métier. Liste typée des actions : `AuditAction`. Consultation : `/api/audit-logs`
(landlord, ses propres actions en V1).
