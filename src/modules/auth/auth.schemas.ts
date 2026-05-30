import { z } from '@hono/zod-openapi';

export const UserPublicSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(['landlord', 'tenant', 'guarantor']),
    createdAt: z.string().datetime(),
  })
  .openapi('UserPublic');

export const LoginRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .openapi('LoginRequest');

export const LoginResponseSchema = z
  .object({
    user: UserPublicSchema,
  })
  .openapi('LoginResponse');

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi('ErrorResponse');

export type UserPublic = z.infer<typeof UserPublicSchema>;
