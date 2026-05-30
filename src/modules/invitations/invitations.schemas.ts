import { z } from '@hono/zod-openapi';
import { UserPublicSchema } from '../auth/auth.schemas.js';

export const CreateInvitationSchema = z
  .object({
    targetType: z.enum(['tenant', 'guarantor']),
    targetId: z.string().uuid(),
  })
  .openapi('CreateInvitation');

export const AcceptInvitationSchema = z
  .object({
    token: z.string().min(20),
    password: z.string().min(8),
  })
  .openapi('AcceptInvitation');

export const InvitationCreatedResponseSchema = z
  .object({
    token: z.string(),
    expiresAt: z.string().datetime(),
  })
  .openapi('InvitationCreatedResponse');

export const AcceptedInvitationResponseSchema = z
  .object({
    user: UserPublicSchema,
  })
  .openapi('AcceptedInvitationResponse');

export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;
