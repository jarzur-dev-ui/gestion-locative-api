import { Readable } from 'node:stream';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { stream as honoStream } from 'hono/streaming';
import { recordUserAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import { DOCUMENT_TYPES_BY_ROLE, type DocumentRole } from './document-types.js';
import {
  DocumentIdParamSchema,
  DocumentListQuerySchema,
  DocumentListSchema,
  DocumentSchema,
  DocumentTypesQuerySchema,
  DocumentTypesResponseSchema,
  PeriodMonthSchema,
  UpdateDocumentStatusSchema,
} from './documents.schemas.js';
import {
  assertDocumentAccessibleByUser,
  listForUser,
  remove,
  restoreDocument,
  toPublicDocument,
  updateStatus,
  uploadDocument,
} from './documents.service.js';
import { readFileStream, FileNotFoundError } from '../../lib/storage.js';

const TAG = 'documents';

// --------------------------------------------------------------------------
// Routes définitions
// --------------------------------------------------------------------------

const listTypesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Liste des types de documents autorisés (filtrable par rôle)',
  request: {
    query: DocumentTypesQuerySchema,
  },
  responses: {
    200: {
      description: 'Whitelist des types de documents',
      content: { 'application/json': { schema: DocumentTypesResponseSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'Lister les documents accessibles à l’utilisateur courant',
  request: {
    query: DocumentListQuerySchema,
  },
  responses: {
    200: {
      description: 'Liste des documents',
      content: { 'application/json': { schema: DocumentListSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

/**
 * Upload multipart. On documente le schéma multipart côté OpenAPI pour que
 * le SDK généré sache produire un form-data. Hono utilise `c.req.parseBody`
 * pour parser le multipart — c'est l'API standard Web (FormData) sous le
 * capot, donc `file` est une instance de `File`.
 */
const uploadRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Uploader un document (multipart/form-data)',
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.custom<File>().openapi({ type: 'string', format: 'binary' }),
            documentTypeKey: z.string(),
            leaseId: z.string().uuid().optional(),
            propertyId: z.string().uuid().optional(),
            periodMonth: PeriodMonthSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Document uploadé',
      content: { 'application/json': { schema: DocumentSchema } },
    },
    400: {
      description: 'Requête invalide (fichier manquant, type interdit, mime non supporté, …)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé à la ressource cible',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    413: {
      description: 'Fichier trop volumineux',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getOneRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Récupérer les métadonnées d’un document',
  request: {
    params: DocumentIdParamSchema,
  },
  responses: {
    200: {
      description: 'Document',
      content: { 'application/json': { schema: DocumentSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Document introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

/**
 * Endpoint binaire — le contenu de la réponse est le fichier lui-même, et
 * non du JSON. On déclare `application/octet-stream` côté OpenAPI ;
 * Hono renverra le `mimeType` réel dans le Content-Type au runtime via le
 * header explicite.
 */
const downloadRoute = createRoute({
  method: 'get',
  path: '/{id}/download',
  tags: [TAG],
  summary: 'Télécharger le binaire d’un document',
  request: {
    params: DocumentIdParamSchema,
  },
  responses: {
    200: {
      description: 'Flux binaire du document',
      content: {
        'application/octet-stream': {
          schema: z.string().openapi({ type: 'string', format: 'binary' }),
        },
      },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Document introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateStatusRoute = createRoute({
  method: 'patch',
  path: '/{id}/status',
  tags: [TAG],
  summary: 'Valider ou rejeter un document (bailleur uniquement)',
  request: {
    params: DocumentIdParamSchema,
    body: {
      content: { 'application/json': { schema: UpdateDocumentStatusSchema } },
    },
  },
  responses: {
    200: {
      description: 'Document mis à jour',
      content: { 'application/json': { schema: DocumentSchema } },
    },
    400: {
      description: 'Requête invalide (ex: motif requis pour "rejected")',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé (non bailleur, ou doc hors périmètre)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Document introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Supprimer un document (bailleur uniquement, soft delete)',
  request: {
    params: DocumentIdParamSchema,
  },
  responses: {
    204: { description: 'Document supprimé' },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Document introuvable',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const restoreRoute = createRoute({
  method: 'post',
  path: '/{id}/restore',
  tags: [TAG],
  summary: 'Restaurer un document soft-deleted (bailleur uniquement)',
  request: {
    params: DocumentIdParamSchema,
  },
  responses: {
    200: {
      description: 'Document restauré',
      content: { 'application/json': { schema: DocumentSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Document introuvable (ou non soft-deleted)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Document déjà restauré',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --------------------------------------------------------------------------
// Router /api/document-types (whitelist)
// --------------------------------------------------------------------------

export const documentTypesRoutes = new OpenAPIHono<AppEnv>();

documentTypesRoutes.use('*', requireAuth);

documentTypesRoutes.openapi(listTypesRoute, (c) => {
  const user = c.get('user')!;
  const { role } = c.req.valid('query');

  // Sans `?role=`, on renvoie la totalité de la whitelist. Le rôle du user
  // n'a pas d'incidence ici (c'est de la doc/UX, pas une frontière ACL),
  // donc on l'expose entièrement aux clients authentifiés.
  if (!role) {
    return c.json(
      {
        landlord: [...DOCUMENT_TYPES_BY_ROLE.landlord],
        tenant: [...DOCUMENT_TYPES_BY_ROLE.tenant],
        guarantor: [...DOCUMENT_TYPES_BY_ROLE.guarantor],
      },
      200,
    );
  }

  // Si l'utilisateur précise un rôle, on vérifie la cohérence : on ne
  // permet pas à un locataire de demander la liste landlord — petite
  // garde-fou par défaut pour éviter de leak de la valeur métier interne
  // à un acteur qui n'en a pas l'usage. Note : c'est une convention,
  // pas une exigence sécurité.
  if (user.role !== 'landlord' && role !== user.role) {
    throw new HTTPException(403, {
      message: `Le rôle ${user.role} ne peut pas consulter la liste ${role}`,
    });
  }

  const r = role as DocumentRole;
  return c.json(
    {
      role: r,
      types: [...DOCUMENT_TYPES_BY_ROLE[r]],
    },
    200,
  );
});

// --------------------------------------------------------------------------
// Router /api/documents (CRUD documents)
// --------------------------------------------------------------------------

export const documentsRoutes = new OpenAPIHono<AppEnv>();

documentsRoutes.use('*', requireAuth);

documentsRoutes.openapi(listRoute, async (c) => {
  const user = c.get('user')!;
  const filters = c.req.valid('query');
  const rows = await listForUser(user, filters);
  return c.json(rows.map(toPublicDocument), 200);
});

documentsRoutes.openapi(uploadRoute, async (c) => {
  const user = c.get('user')!;

  // `parseBody({ all: true })` permet de récupérer plusieurs valeurs pour
  // une même clé (utile si on devait permettre l'upload multi-fichiers).
  // Ici on n'attend qu'un seul `file`. Côté hono web standard, un `File`
  // arrive comme instance `File` (globalThis.File depuis Node 20).
  const body = await c.req.parseBody({ all: true });

  // Hono renvoie soit une valeur, soit un tableau (mode `all: true`). On
  // garde la première occurrence pour chaque clé attendue.
  const pickOne = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

  const fileField = pickOne(body.file);
  if (!(fileField instanceof File)) {
    throw new HTTPException(400, { message: 'Champ `file` manquant ou invalide' });
  }

  const documentTypeKeyRaw = pickOne(body.documentTypeKey);
  if (typeof documentTypeKeyRaw !== 'string' || documentTypeKeyRaw.length === 0) {
    throw new HTTPException(400, { message: 'Champ `documentTypeKey` manquant' });
  }

  const leaseIdRaw = pickOne(body.leaseId);
  const propertyIdRaw = pickOne(body.propertyId);
  const periodMonthRaw = pickOne(body.periodMonth);

  // Validation légère des champs string vs UUID/format — on délègue les
  // erreurs à Zod via parse() ponctuel plutôt que dupliquer les regex.
  const uuidSchema = z.string().uuid();
  const leaseId =
    typeof leaseIdRaw === 'string' && leaseIdRaw.length > 0
      ? uuidSchema.parse(leaseIdRaw)
      : undefined;
  const propertyId =
    typeof propertyIdRaw === 'string' && propertyIdRaw.length > 0
      ? uuidSchema.parse(propertyIdRaw)
      : undefined;
  const periodMonth =
    typeof periodMonthRaw === 'string' && periodMonthRaw.length > 0
      ? PeriodMonthSchema.parse(periodMonthRaw)
      : undefined;

  const doc = await uploadDocument(user, {
    file: fileField,
    documentTypeKey: documentTypeKeyRaw,
    leaseId,
    propertyId,
    periodMonth,
  });

  await recordUserAudit(c, user.id, {
    action: 'document.upload',
    entityType: 'document',
    entityId: doc.id,
    payload: { type: doc.documentTypeKey, leaseId: doc.leaseId, propertyId: doc.propertyId },
  });

  return c.json(toPublicDocument(doc), 201);
});

documentsRoutes.openapi(getOneRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const doc = await assertDocumentAccessibleByUser(id, user);
  return c.json(toPublicDocument(doc), 200);
});

documentsRoutes.openapi(downloadRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const doc = await assertDocumentAccessibleByUser(id, user);

  let nodeStream: NodeJS.ReadableStream;
  try {
    nodeStream = await readFileStream(doc.filePath);
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      // Cas pathologique : la ligne DB existe mais le fichier a disparu
      // (suppression manuelle, migration ratée…). On reste cohérent côté
      // API en renvoyant un 404.
      throw new HTTPException(404, { message: 'Fichier introuvable' });
    }
    throw err;
  }

  // Hono accepte un `ReadableStream<Uint8Array>` natif Web. On convertit le
  // stream Node via `Readable.toWeb()` (dispo en Node 17+). On caste car
  // les types Node/Web diffèrent légèrement, mais le runtime est compatible.
  const webStream = Readable.toWeb(
    nodeStream instanceof Readable ? nodeStream : Readable.from(nodeStream),
  ) as ReadableStream<Uint8Array>;

  // Pour les téléchargements binaires on évite de passer par le helper
  // `streamResponse` qui ajoute du chunking SSE. `c.body(stream, ...)` est
  // suffisant — Hono propage le stream tel quel dans la Response.
  // On échappe le filename pour éviter les caractères dangereux dans le
  // header. RFC 5987 → on utilise filename* + filename ASCII fallback.
  const safeAscii = doc.originalFilename.replace(/[^\x20-\x7E]+/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(doc.originalFilename);

  return c.body(webStream, 200, {
    'Content-Type': doc.mimeType,
    'Content-Length': String(doc.fileSizeBytes),
    'Content-Disposition': `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
    // On évite que des proxys mettent en cache un binaire potentiellement
    // sensible (ex: pièce d'identité). Cache léger côté client uniquement.
    'Cache-Control': 'private, no-store',
  });
});

documentsRoutes.openapi(updateStatusRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const data = c.req.valid('json');
  const row = await updateStatus(id, user, data);
  // L'action d'audit dépend du verbe métier : validate vs reject. On lit
  // directement le statut du body validé (Zod garantit `validated`|`rejected`).
  await recordUserAudit(c, user.id, {
    action: data.statusKey === 'validated' ? 'document.validate' : 'document.reject',
    entityType: 'document',
    entityId: row.id,
  });
  return c.json(toPublicDocument(row), 200);
});

documentsRoutes.openapi(deleteRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  await remove(id, user);
  await recordUserAudit(c, user.id, {
    action: 'document.delete',
    entityType: 'document',
    entityId: id,
  });
  return c.body(null, 204);
});

documentsRoutes.openapi(restoreRoute, async (c) => {
  const user = c.get('user')!;
  const { id } = c.req.valid('param');
  const doc = await restoreDocument(id, user);
  await recordUserAudit(c, user.id, {
    action: 'document.restore',
    entityType: 'document',
    entityId: doc.id,
  });
  return c.json(toPublicDocument(doc), 200);
});

// `honoStream` n'est pas utilisé pour le moment — on garde l'import pour
// pouvoir basculer facilement si on doit faire du chunking actif (ex:
// génération PDF à la volée). Le `void` évite un warning unused-import.
void honoStream;
