import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { closeMailer } from '../lib/mailer.js';
import { closePdfBrowser } from '../lib/pdf-renderer.js';
import { runDocumentsOrphanCleanupTask } from './documents-orphan-cleanup.task.js';
import { runDocumentsPurgeTask } from './documents-purge.task.js';
import { runDailyRentPeriodTasks } from './rent-periods.task.js';

let scheduledTasks: cron.ScheduledTask[] = [];

export function startScheduler(): void {
  // Tous les jours à 08:00 Europe/Paris
  // - Crée les rent_periods du mois prochain pour chaque bail actif (idempotent)
  // - Envoie les avis d'échéance pour les périodes draft dont due_date <= J+10
  const dailyTask = cron.schedule(
    '0 8 * * *',
    async () => {
      const startedAt = Date.now();
      logger.info('scheduler: daily rent-period task — start');
      try {
        const result = await runDailyRentPeriodTasks();
        logger.info(
          { ...result, durationMs: Date.now() - startedAt },
          'scheduler: daily rent-period task — done',
        );
      } catch (err) {
        logger.error({ err }, 'scheduler: daily rent-period task — failed');
      }
    },
    { timezone: 'Europe/Paris' },
  );

  scheduledTasks.push(dailyTask);

  // Tous les jours à 03:00 Europe/Paris : purge des documents soft-deleted dépassant le TTL
  const purgeTask = cron.schedule(
    '0 3 * * *',
    async () => {
      const startedAt = Date.now();
      logger.info('scheduler: documents-purge — start');
      try {
        const result = await runDocumentsPurgeTask();
        logger.info(
          { ...result, durationMs: Date.now() - startedAt },
          'scheduler: documents-purge — done',
        );
      } catch (err) {
        logger.error({ err }, 'scheduler: documents-purge — failed');
      }
    },
    { timezone: 'Europe/Paris' },
  );
  scheduledTasks.push(purgeTask);

  // Tous les jours à 04:00 Europe/Paris : cleanup des fichiers orphelins sur le volume
  const orphanCleanupTask = cron.schedule(
    '0 4 * * *',
    async () => {
      const startedAt = Date.now();
      logger.info('scheduler: orphan-cleanup — start');
      try {
        const result = await runDocumentsOrphanCleanupTask();
        logger.info(
          { ...result, durationMs: Date.now() - startedAt },
          'scheduler: orphan-cleanup — done',
        );
      } catch (err) {
        logger.error({ err }, 'scheduler: orphan-cleanup — failed');
      }
    },
    { timezone: 'Europe/Paris' },
  );
  scheduledTasks.push(orphanCleanupTask);

  logger.info(
    'scheduler: démarré (3 tâches : rent-periods 08:00, purge 03:00, orphan-cleanup 04:00)',
  );
}

export async function stopScheduler(): Promise<void> {
  for (const task of scheduledTasks) {
    task.stop();
  }
  scheduledTasks = [];
  await Promise.allSettled([closePdfBrowser(), closeMailer()]);
  logger.info('scheduler: arrêté + browser + mailer fermés');
}
