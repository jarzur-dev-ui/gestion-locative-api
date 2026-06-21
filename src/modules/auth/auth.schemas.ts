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

export const ForgotPasswordRequestSchema = z
  .object({
    email: z.string().email(),
  })
  .openapi('ForgotPasswordRequest');

export const ResetPasswordRequestSchema = z
  .object({
    token: z.string().min(20),
    password: z.string().min(8),
  })
  .openapi('ResetPasswordRequest');

export const ResetPasswordResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .openapi('ResetPasswordResponse');

export type UserPublic = z.infer<typeof UserPublicSchema>;
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
