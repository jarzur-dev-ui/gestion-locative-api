import { Readable } from 'node:stream';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { logger } from '../../lib/logger.js';
import { FileNotFoundError, readFileStream } from '../../lib/storage.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import { ShareTokenParamSchema } from './document-shares.schemas.js';
import {
  maskToken,
  recordShareAccess,
  resolveShareForDownload,
} from './document-shares.service.js';

const TAG = 'document-shares-public';

const publicDownloadRoute = createRoute({
  method: 'get',
  path: '/{token}',
  tags: [TAG],
  summary: 'Télécharger un document via un lien de partage public',
  description:
    "Endpoint public — pas d'authentification. Retourne 410 si le partage est expiré ou révoqué.",
  request: {
    params: ShareTokenParamSchema,
  },
  responses: {
    200: {
      description: 'Fichier streamé en téléchargement',
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    },
    404: {
      description: 'Document introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Partage expiré, révoqué ou inconnu',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

/**
 * Sanitization minimale pour `Content-Disposition`.
 * - Supprime les caractères de contrôle (0x00–0x1F, 0x7F).
 * - Supprime les séparateurs de chemin (`/`, `\`) — défense en profondeur,
 *   même si le filename ne sert que comme suggestion côté client.
 * - Supprime les guillemets pour ne pas casser le `filename="..."`.
 * - Tronque à 255 caractères (limite POSIX classique).
 *
 * On retourne une version ASCII-safe + une version UTF-8 percent-encodée
 * (RFC 5987) pour le `filename*` ; les clients modernes préfèreront le
 * second si présent.
 */
function sanitizeFilename(name: string): { ascii: string; utf8Encoded: string } {
  // On retire les caractères de contrôle (0x00–0x1F, 0x7F) sans regex à
  // littéral de contrôle (cf. noControlCharactersInRegex) : on filtre par code
  // point, c'est explicite et lint-safe.
  const stripped = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .replace(/[\\/]/g, '_')
    .replace(/"/g, '')
    .trim()
    .slice(0, 255);

  const safe = stripped.length > 0 ? stripped : 'document';

  // Version ASCII-only pour `filename=` (fallback historique). Les caractères
  // non-ASCII sont remplacés par '_' pour éviter les warnings côté browsers.
  // 0x20–0x7E = plage ASCII imprimable ; pas de caractère de contrôle ici.
  const ascii = safe.replace(/[^ -~]/g, '_');

  // Version UTF-8 percent-encodée pour `filename*=UTF-8''…` (RFC 5987).
  // encodeURIComponent gère le pourcent-encoding, on enlève juste les
  // caractères réservés qui posent problème en pratique.
  const utf8Encoded = encodeURIComponent(safe);

  return { ascii, utf8Encoded };
}

function buildContentDisposition(originalFilename: string): string {
  const { ascii, utf8Encoded } = sanitizeFilename(originalFilename);
  // On fournit toujours les deux formes — les clients récents utilisent
  // `filename*` qui prend précédence, les vieux clients tombent sur
  // `filename`. Cf. RFC 6266 §4.3.
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8Encoded}`;
}

export const sharePublicRoutes = new OpenAPIHono<AppEnv>();

// Pas de middleware d'auth ici : c'est volontaire. Le token est le secret
// porteur, n'importe qui le possédant peut télécharger. Le sessionMiddleware
// global est toujours présent (il définit user=null si pas de cookie), ce
// qui est sans effet.
sharePublicRoutes.openapi(publicDownloadRoute, async (c) => {
  const { token } = c.req.valid('param');

  const resolved = await resolveShareForDownload(token);
  if (!resolved) {
    // 410 Gone couvre tous les cas où le lien a été un jour valide mais ne
    // l'est plus (expiré, révoqué) OU n'a jamais existé. On évite 404 pour
    // ne pas distinguer "inconnu" de "révoqué" — c'est un anti-pattern
    // d'énumération mais aussi une UX plus simple côté front (un seul état
    // d'erreur "lien invalide").
    throw new HTTPException(410, { message: 'Lien de partage invalide ou expiré' });
  }

  const { share, document } = resolved;

  // Audit log — token masqué pour ne pas exposer le secret en clair.
  logger.info(
    {
      shareToken: maskToken(share.token),
      documentId: document.id,
      userAgent: c.req.header('user-agent') ?? null,
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    },
    'document-shares: public download',
  );

  // Incrément du compteur — best-effort, ne bloque pas la réponse en cas
  // d'erreur DB. `void` pour expliciter qu'on n'attend pas la promise.
  void recordShareAccess(share.token);

  let nodeStream: NodeJS.ReadableStream;
  try {
    nodeStream = await readFileStream(document.filePath);
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      // Cas théoriquement impossible (CASCADE protège le document, et le
      // fichier devrait toujours être présent tant que le document existe),
      // mais on log et on renvoie 404 plutôt que de leak un 500.
      logger.error(
        { documentId: document.id, filePath: document.filePath },
        'document-shares: file missing on storage',
      );
      throw new HTTPException(404, { message: 'Fichier introuvable' });
    }
    throw err;
  }

  c.header('Content-Type', document.mimeType);
  c.header('Content-Length', String(document.fileSizeBytes));
  c.header('Content-Disposition', buildContentDisposition(document.originalFilename));
  // Le contenu est protégé par un token opaque ; on demande explicitement
  // aux intermédiaires de ne pas le cacher (sinon une révocation manuelle
  // serait inopérante derrière un cache).
  c.header('Cache-Control', 'private, no-store');
  // Empêche le MIME-sniffing du navigateur : le contenu est servi avec le
  // type déclaré uniquement (anti XSS sur un fichier malveillant rendu inline).
  c.header('X-Content-Type-Options', 'nosniff');

  // Hono `stream()` attend un WHATWG ReadableStream — on convertit le Node
  // Readable retourné par `readFileStream`. `Readable.toWeb` est dispo
  // depuis Node 17.
  return stream(c, async (s) => {
    const webStream = Readable.toWeb(
      nodeStream instanceof Readable ? nodeStream : Readable.from(nodeStream),
    ) as ReadableStream<Uint8Array>;
    await s.pipe(webStream);
  });
});
