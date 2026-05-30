import { logger } from '../../lib/logger.js';

export function sendInvitationEmail(to: string, magicLink: string): void {
  logger.info(
    { to, magicLink },
    '[MAILER STUB] Email invitation à envoyer — remplacement par nodemailer prévu Milestone 4',
  );
}
